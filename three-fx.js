// 純裝飾性 WebGL 特效層。這支檔案永遠不能讓遊戲的核心功能失敗——
// 任何一步（CDN 載入、WebGL 建立）失敗，就單純不設定 window.ThreeFX，
// app.js 會依此決定要不要開放進入拼字關卡（見 app.js 的「開始遊戲」硬性門檻）。

import * as THREE from 'three';

var PALETTE = [0xffb703, 0xfb8500, 0x06d6a0, 0xef476f, 0x8ecae6, 0xffd700];
var MAX_PARTICLES = 260;

var scene, camera, renderer, points;
var models = {}; // trophy / gift / chest（chest 額外附 chestLid 參考）
var activeParticles = null;
var activeModel = null;
var rafId = null;

function makeDotTexture() {
  var size = 64;
  var canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  var ctx = canvas.getContext('2d');
  var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function hexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function onResize() {
  camera.left = window.innerWidth / -2;
  camera.right = window.innerWidth / 2;
  camera.top = window.innerHeight / 2;
  camera.bottom = window.innerHeight / -2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------- 過關獎勵用的低多邊形手刻模型（不載外部模型檔案，避免多一個下載失敗點） ----------
// 這個場景用正交相機、座標空間直接對應螢幕像素——跟粒子系統同一個陷阱：
// 每個尺寸數字都要落在大約 100~300 這個範圍，寫 1 這種「三維軟體常見單位」會小到看不見。

function buildTrophyModel() {
  var group = new THREE.Group();
  var gold = new THREE.MeshStandardMaterial({ color: 0xffd700, roughness: 0.3, metalness: 0.5 });

  var cup = new THREE.Mesh(new THREE.CylinderGeometry(60, 32, 95, 20), gold);
  cup.position.y = 75;
  group.add(cup);

  var handleGeo = new THREE.TorusGeometry(24, 7, 8, 16, Math.PI * 1.3);
  var handleL = new THREE.Mesh(handleGeo, gold);
  handleL.position.set(-60, 78, 0);
  handleL.rotation.y = Math.PI / 2;
  group.add(handleL);
  var handleR = handleL.clone();
  handleR.position.x = 60;
  handleR.rotation.y = -Math.PI / 2;
  group.add(handleR);

  var stem = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 60, 14), gold);
  stem.position.y = 15;
  group.add(stem);

  var base = new THREE.Mesh(new THREE.CylinderGeometry(55, 65, 22, 20), gold);
  base.position.y = -25;
  group.add(base);

  return group;
}

function buildGiftBoxModel() {
  var group = new THREE.Group();
  var boxMat = new THREE.MeshStandardMaterial({ color: 0xef476f, roughness: 0.55, metalness: 0.05 });
  var ribbonMat = new THREE.MeshStandardMaterial({ color: 0xffd700, roughness: 0.3, metalness: 0.4 });

  var box = new THREE.Mesh(new THREE.BoxGeometry(150, 110, 150), boxMat);
  group.add(box);

  var ribbonV = new THREE.Mesh(new THREE.BoxGeometry(22, 115, 155), ribbonMat);
  group.add(ribbonV);
  var ribbonH = new THREE.Mesh(new THREE.BoxGeometry(155, 115, 22), ribbonMat);
  group.add(ribbonH);

  var bowL = new THREE.Mesh(new THREE.SphereGeometry(20, 10, 8), ribbonMat);
  bowL.position.set(-18, 68, 0);
  bowL.scale.set(1, 0.7, 0.6);
  group.add(bowL);
  var bowR = bowL.clone();
  bowR.position.x = 18;
  group.add(bowR);
  var bowKnot = new THREE.Mesh(new THREE.SphereGeometry(12, 10, 8), ribbonMat);
  bowKnot.position.set(0, 60, 0);
  group.add(bowKnot);

  return group;
}

// 回傳 { group, lidGroup }：lidGroup 的原點就是鉸鏈位置（底座後緣頂部），
// 蓋子網格相對鉸鏈往 +Z 偏移，所以 lidGroup.rotation.x 轉負角度時，蓋子會
// 繞著後緣往上、往後掀開，跟真實的寶箱開蓋動作方向一致。
function buildChestModel() {
  var group = new THREE.Group();
  var woodMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.75, metalness: 0.05 });
  var goldMat = new THREE.MeshStandardMaterial({ color: 0xffd700, roughness: 0.3, metalness: 0.5 });

  var base = new THREE.Mesh(new THREE.BoxGeometry(170, 90, 110), woodMat);
  base.position.y = -35;
  group.add(base);

  var band = new THREE.Mesh(new THREE.BoxGeometry(178, 14, 118), goldMat);
  band.position.y = -35;
  group.add(band);

  var lidGroup = new THREE.Group();
  lidGroup.position.set(0, 10, -55);
  group.add(lidGroup);

  var lid = new THREE.Mesh(new THREE.BoxGeometry(170, 40, 110), woodMat);
  lid.position.set(0, 10, 55);
  lidGroup.add(lid);

  var lidBand = new THREE.Mesh(new THREE.BoxGeometry(178, 44, 118), goldMat);
  lidBand.scale.set(1, 0.3, 1);
  lidBand.position.set(0, 10, 55);
  lidGroup.add(lidBand);

  var lock = new THREE.Mesh(new THREE.BoxGeometry(24, 28, 14), goldMat);
  lock.position.set(0, 10, 111);
  lidGroup.add(lock);

  return { group: group, lidGroup: lidGroup };
}

// 三個模型只在初始化時建一次、常駐場景中（用 visible 開關），不要每次過關都重建
// 又丟棄幾何體/材質——那樣需要額外處理 WebGL 資源釋放，複雜度換不到什麼好處。
function buildModels() {
  models.trophy = buildTrophyModel();
  models.gift = buildGiftBoxModel();
  var chestBuilt = buildChestModel();
  models.chest = chestBuilt.group;
  models.chestLid = chestBuilt.lidGroup;
  [models.trophy, models.gift, models.chest].forEach(function (g) {
    g.visible = false;
    scene.add(g);
  });
}

function initScene() {
  var container = document.getElementById('three-fx-layer');
  if (!container) return false;

  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(
    window.innerWidth / -2, window.innerWidth / 2,
    window.innerHeight / 2, window.innerHeight / -2,
    1, 1000
  );
  camera.position.z = 100;

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  window.addEventListener('resize', onResize);

  // 過關獎勵模型用 MeshStandardMaterial，需要實際光源才會有立體明暗，
  // 粒子系統用的 PointsMaterial 不吃光源，所以這是加模型才需要補的東西。
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  var dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(150, 260, 400);
  scene.add(dirLight);

  var geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
  geometry.setDrawRange(0, 0);

  var material = new THREE.PointsMaterial({
    // sizeAttenuation:false 時 size 是 framebuffer 像素（drawing buffer），
    // 不是 CSS 像素。renderer 有 setPixelRatio(2)，同一個 size 在 2x 螢幕上
    // 畫出來的實際大小只有 1x 螢幕的一半，所以要乘回 pixelRatio 才能讓
    // 粒子在不同螢幕密度下看起來一樣大。
    size: 40 * renderer.getPixelRatio(),
    map: makeDotTexture(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    // sizeAttenuation 預設會依相機距離縮放大小，這個公式是為透視相機設計的；
    // 我們用正交相機、座標空間直接對應到螢幕像素，套用透視縮放公式會讓算出來
    // 的粒子大小遠比預期小很多，這是先前「3D 特效不明顯」的主因。
    sizeAttenuation: false
  });

  points = new THREE.Points(geometry, material);
  scene.add(points);

  buildModels();

  renderer.render(scene, camera); // 立即渲染一次，及早驗證 WebGL context 真的可用
  return true;
}

function burst(count, opts) {
  count = Math.min(count, MAX_PARTICLES);
  var originX = opts.originX || 0;
  var originY = opts.originY || 0;
  var spreadX = opts.spreadX || window.innerWidth * 0.3;
  var speedY = opts.speedY || 220;
  var gravity = opts.gravity || 420;
  var duration = opts.duration || 1200;
  var radial = !!opts.radial; // true：像煙火一樣從一點朝四面八方炸開；false：像雨一樣從一片寬區域落下
  var palette = opts.palette || PALETTE;
  // radial 預設整圈 360 度炸開；angleMin/angleRange 可以限制成一個扇形角度範圍
  // （0=正右、Math.PI/2=正上方），答對時用來讓粒子只往上方扇形噴，
  // 避免往下噴到答題區、蓋住孩子正在看的字母方塊。
  var angleMin = opts.angleMin != null ? opts.angleMin : 0;
  var angleRange = opts.angleRange != null ? opts.angleRange : Math.PI * 2;

  var positions = points.geometry.attributes.position.array;
  var colors = points.geometry.attributes.color.array;
  var velocities = [];

  for (var i = 0; i < count; i++) {
    if (radial) {
      positions[i * 3] = originX + (Math.random() - 0.5) * 16;
      positions[i * 3 + 1] = originY + (Math.random() - 0.5) * 16;
    } else {
      positions[i * 3] = originX + (Math.random() - 0.5) * spreadX;
      positions[i * 3 + 1] = originY + (Math.random() - 0.5) * 20;
    }
    positions[i * 3 + 2] = (Math.random() - 0.5) * 20;

    var rgb = hexToRgb(palette[Math.floor(Math.random() * palette.length)]);
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];

    if (radial) {
      var angle = angleMin + Math.random() * angleRange;
      var speed = speedY * (0.5 + Math.random() * 0.8);
      velocities.push({ vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
    } else {
      velocities.push({
        vx: (Math.random() - 0.5) * 160,
        vy: speedY * (0.6 + Math.random() * 0.8)
      });
    }
  }

  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
  points.geometry.setDrawRange(0, count);
  points.material.opacity = 1;

  activeParticles = { count: count, velocities: velocities, gravity: gravity, startTime: performance.now(), duration: duration };
  ensureLoop();
}

function ensureLoop() {
  if (rafId === null) rafId = requestAnimationFrame(tick);
}

function hideActiveModel() {
  if (activeModel && activeModel.group) activeModel.group.visible = false;
  activeModel = null;
}

// 統一的渲染迴圈：粒子（答對用）跟模型展示（過關用）理論上不會同時觸發
// （分屬遊戲畫面跟結果畫面），但兩邊各自獨立判斷是否還在播，避免其中一個
// 播完就把另一個也一起中斷掉——之前粒子版的 tick() 只認得粒子自己，
// 若同時有模型在轉，粒子播完的那一刻就會誤把模型動畫也一起停掉。
function tick(now) {
  var stillActive = false;
  var dt = 1 / 60;

  if (activeParticles) {
    stillActive = true;
    var positions = points.geometry.attributes.position.array;
    var elapsed = now - activeParticles.startTime;
    for (var i = 0; i < activeParticles.count; i++) {
      var v = activeParticles.velocities[i];
      positions[i * 3] += v.vx * dt;
      positions[i * 3 + 1] += v.vy * dt;
      v.vy -= activeParticles.gravity * dt;
    }
    points.geometry.attributes.position.needsUpdate = true;
    var pProgress = elapsed / activeParticles.duration;
    if (pProgress >= 1) {
      points.geometry.setDrawRange(0, 0);
      activeParticles = null;
    } else if (pProgress > 0.7) {
      points.material.opacity = 1 - (pProgress - 0.7) / 0.3;
    }
  }

  if (activeModel) {
    stillActive = true;
    var m = activeModel;
    var mElapsed = now - m.startTime;
    m.group.rotation.y += m.rotateSpeed * dt;
    if (m.kind === 'chest' && !m.opened) {
      var lidProgress = Math.min(mElapsed / m.lidDuration, 1);
      m.lidGroup.rotation.x = -lidProgress * Math.PI * 0.58;
      if (lidProgress >= 1) {
        m.opened = true;
        if (m.onLidOpen) {
          // 裝飾層絕不能讓 app.js 的 DOM 更新錯誤把這裡也拖垮，出事只印警告。
          try { m.onLidOpen(); } catch (err) { console.warn('開寶箱回呼發生錯誤，不影響遊戲本身', err); }
        }
      }
    }
    if (mElapsed >= m.duration) {
      m.group.visible = false;
      activeModel = null;
    }
  }

  renderer.render(scene, camera);
  if (stillActive) {
    rafId = requestAnimationFrame(tick);
  } else {
    rafId = null;
  }
}

// ---------- 對外 API ----------

function celebrateCorrect() {
  // 答對很頻繁，維持輕量：只在「彩帶雨／煙火」兩種較低調的樣式間輪替，不用大場面模型。
  var style = Math.random() < 0.5 ? 'rain' : 'burst';
  if (style === 'burst') {
    burst(60, {
      originY: window.innerHeight * 0.18,
      speedY: 240,
      gravity: 400,
      duration: 1100,
      radial: true,
      // 炸開角度限制成朝上的扇形，避免整圈 360 度時有粒子直接往下噴過答題區。
      angleMin: Math.PI * 0.15,
      angleRange: Math.PI * 0.7
    });
  } else {
    burst(60, {
      originY: window.innerHeight * 0.15,
      spreadX: window.innerWidth * 0.5,
      speedY: 180,
      gravity: 420,
      duration: 1100
    });
  }
}

// 一般過關（不論幾顆星，尚未拿到這關貼紙時）：獎盃／禮物盒隨機展示，慢慢旋轉。
function celebrateLevelComplete() {
  hideActiveModel();
  var pick = Math.random() < 0.5 ? models.trophy : models.gift;
  pick.rotation.set(0, 0, 0);
  pick.visible = true;
  activeModel = { group: pick, kind: 'showcase', startTime: performance.now(), duration: 1800, rotateSpeed: 1.1 };
  ensureLoop();
}

// 首次三星過關：專屬的開寶箱動畫。蓋子掀開的那一刻呼叫 onLidOpen，讓 app.js
// 在正確的時間點彈出貼紙視窗，而不是靠 app.js 自己用 setTimeout 猜時間。
function celebrateChestOpen(onLidOpen) {
  hideActiveModel();
  models.chest.rotation.set(0, 0, 0);
  models.chestLid.rotation.x = 0;
  models.chest.visible = true;
  activeModel = {
    group: models.chest, kind: 'chest', lidGroup: models.chestLid,
    startTime: performance.now(), duration: 2400, rotateSpeed: 0.3,
    lidDuration: 700, opened: false, onLidOpen: onLidOpen || null
  };
  ensureLoop();
}

// 中途離開結果畫面（再玩一次／選其他難度／回主選單）時要呼叫這個：清掉正在播放的
// 模型展示或開寶箱動畫，最重要的是讓還沒觸發的 onLidOpen 回呼永遠不會再被呼叫——
// 不然孩子在寶箱打開前就點走，貼紙彈窗會晚個半秒才憑空跳出來蓋在下一個畫面上面。
function cancelCelebration() {
  if (activeParticles) {
    points.geometry.setDrawRange(0, 0);
    activeParticles = null;
  }
  hideActiveModel();
}

try {
  if (initScene()) {
    window.ThreeFX = {
      celebrateCorrect: celebrateCorrect,
      celebrateLevelComplete: celebrateLevelComplete,
      celebrateChestOpen: celebrateChestOpen,
      cancelCelebration: cancelCelebration
    };
    window.dispatchEvent(new CustomEvent('threefx-ready'));
  } else {
    window.dispatchEvent(new CustomEvent('threefx-error'));
  }
} catch (err) {
  console.warn('三維特效初始化失敗，拼字遊戲關卡會被暫時鎖住。', err);
  window.dispatchEvent(new CustomEvent('threefx-error'));
}
