(function () {
  'use strict';

  // ---------- Constants ----------
  var PROGRESS_KEY = 'spelling_game_progress_v1';
  var MIN_WORDS_PER_LEVEL = 3; // 少於這個題數的關卡不開放（例如顏色初級只有 red 一個字），避免一玩就結束
  var VIEWS = ['loading', 'load-error', 'splash', 'theme-select', 'level-select', 'game', 'result', 'progress', 'flashcards', 'blend'];

  var PRAISE_MESSAGES = ['太棒了！', '你好厲害！', '答對囉，繼續加油！', 'Super！', '你是拼字小天才！'];
  var ENCOURAGE_MESSAGES = ['再試一次，你可以的！', '快拼好了，加油！', '沒關係，再排排看！', '慢慢來，你做得到！'];
  var RESULT_MESSAGES = {
    3: ['太完美了！你是拼字大師！', '全部答對，超級厲害！', '滿分過關，你根本是天才！', '無敵！這關被你征服了！'],
    2: ['表現很棒，再接再厲！', '很不錯喔，快到滿分了！', '超讚的表現，繼續保持！'],
    1: ['有進步了，再多練習一下！', '繼續加油，你會更棒！', '一步一步來，你做得到！'],
    0: ['沒關係，再挑戰一次吧！', '多練習幾次就會更熟悉囉！', '別氣餒，下一輪會更順！']
  };

  // ---------- Module state ----------
  var WORD_BANK = [], THEMES = [], DIFFICULTY_TIERS = [];
  var progress = null;
  var gameState = null;
  var currentThemeId = null;
  var currentTier = null;
  var cachedEnglishVoice = null;
  var audioCtx = null;
  var audioUnlocked = false;
  var themeSelectMode = 'quiz'; // 'quiz'：選主題後進選難度；'browse'：進字卡瀏覽；'blend'：進拼讀練習
  var flashcardsState = null;
  var flashcardSpeakTimer = null;
  var blendState = null;

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }

  function showView(name) {
    VIEWS.forEach(function (v) { $('view-' + v).hidden = (v !== name); });
  }

  var toastTimer = null;
  function showToast(msg) {
    var toast = $('toast');
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2400);
  }

  function mascotReact(kind) {
    var mascot = $('mascot');
    mascot.classList.remove('happy', 'wiggle', 'cheer');
    void mascot.offsetWidth;
    if (kind) mascot.classList.add(kind);
  }

  // 答對時的輕量變化：在兩個輕巧的待機動畫間隨機切換，不是每次都同一個彈跳，
  // 但刻意不做成跟結果畫面同等級的大動作，避免拖慢拼字節奏。
  function mascotReactCorrect() {
    mascotReact(Math.random() < 0.5 ? 'happy' : 'wiggle');
  }

  // 動畫結束後移回待機狀態，避免 mascot 卡在 happy/wiggle/cheer 姿勢不再回到 idleBob
  $('mascot') && $('mascot').addEventListener('animationend', function (e) {
    if (e.animationName === 'happyJump' || e.animationName === 'wiggle' || e.animationName === 'cheer') {
      e.target.classList.remove('happy', 'wiggle', 'cheer');
    }
  });

  // ---------- Data loading ----------
  function loadGameData() {
    showView('loading');
    fetch('data.json')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        WORD_BANK = data.wordBank;
        THEMES = data.themes;
        DIFFICULTY_TIERS = data.difficultyTiers;
        progress = loadProgress();
        initVoices();
        showView('splash');
      })
      .catch(function (err) {
        console.error('資料載入失敗', err);
        showView('load-error');
      });
  }

  // ---------- Progress storage ----------
  function defaultProgress() {
    return {
      schemaVersion: 1,
      settings: { hintMode: 'both', soundEnabled: true, speechRate: 0.8 },
      levels: {},
      collectibles: {}
    };
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem(PROGRESS_KEY);
      if (!raw) return defaultProgress();
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== 1 || !parsed.levels || typeof parsed.levels !== 'object') {
        return defaultProgress();
      }
      parsed.settings = Object.assign(defaultProgress().settings, parsed.settings || {});
      // 舊進度檔（這次新增貼紙功能之前存的）不會有 collectibles 欄位，容錯補一個空物件，
      // 不 bump schemaVersion——沿用既有「缺欄位就補預設值」的容錯模式。
      if (!parsed.collectibles || typeof parsed.collectibles !== 'object') parsed.collectibles = {};
      return parsed;
    } catch (err) {
      return defaultProgress();
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch (err) {
      console.warn('無法儲存進度', err);
    }
  }

  function levelKey(themeId, tier) { return themeId + '_' + tier; }

  function getLevelProgress(themeId, tier) {
    var key = levelKey(themeId, tier);
    if (!progress.levels[key]) {
      progress.levels[key] = {
        themeId: themeId, tier: tier, attempts: 0, correctCount: 0,
        bestAccuracy: 0, bestStars: 0, completed: false,
        wordProgress: {}, lastPlayedAt: null
      };
    }
    return progress.levels[key];
  }

  function recordAnswer(themeId, tier, wordId, isCorrect) {
    var lp = getLevelProgress(themeId, tier);
    lp.attempts++;
    if (isCorrect) lp.correctCount++;
    if (!lp.wordProgress[wordId]) lp.wordProgress[wordId] = { correct: 0, wrong: 0 };
    lp.wordProgress[wordId][isCorrect ? 'correct' : 'wrong']++;
    lp.lastPlayedAt = new Date().toISOString();
    progress.lastPlayedAt = lp.lastPlayedAt;
    saveProgress();
  }

  function finalizeLevelRun(themeId, tier, accuracy, stars) {
    var lp = getLevelProgress(themeId, tier);
    lp.bestAccuracy = Math.max(lp.bestAccuracy, accuracy);
    lp.bestStars = Math.max(lp.bestStars, stars);
    lp.completed = true;
    lp.lastPlayedAt = new Date().toISOString();
    saveProgress();
  }

  function exportProgress() {
    var blob = new Blob([JSON.stringify(progress, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'spelling-game-progress-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('進度已匯出！');
  }

  function importProgressFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || parsed.schemaVersion !== 1 || !parsed.levels || typeof parsed.levels !== 'object') {
          throw new Error('格式不符');
        }
        progress = parsed;
        progress.settings = Object.assign(defaultProgress().settings, progress.settings || {});
        if (!progress.collectibles || typeof progress.collectibles !== 'object') progress.collectibles = {};
        saveProgress();
        renderProgressTable();
        renderCollectiblesGrid();
        showToast('進度已匯入！');
      } catch (err) {
        showToast('匯入失敗：檔案格式不正確');
      }
    };
    reader.onerror = function () { showToast('匯入失敗：無法讀取檔案'); };
    reader.readAsText(file);
  }

  // ---------- Word bank helpers ----------
  function getWordsForLevel(themeId, tier) {
    var rule = DIFFICULTY_TIERS.find(function (t) { return t.tier === tier; });
    return WORD_BANK.filter(function (w) {
      return w.theme === themeId && w.word.length >= rule.minLen && w.word.length <= rule.maxLen;
    });
  }

  // 一個主題的「關卡定義」清單。預設（大多數主題）沿用全站共用的長度分級
  // （DIFFICULTY_TIERS：初級3字母／中級4字母／高級5+字母）。如果主題在 data.json
  // 裡定義了 customLevels，就改用那份清單——每個關卡有自己的名字＋明確指定的單字
  // id 清單，不受長度分級限制（例如混合各種字母長度的複習關卡）。兩種關卡的 tier
  // 欄位型別不同（數字 vs 字串），但因為全站只拿它當 levelKey()/progress 的一個
  // 不透明識別碼使用，不需要是數字。
  function getLevelDefsForTheme(themeId) {
    var theme = THEMES.find(function (t) { return t.id === themeId; });
    if (theme && theme.customLevels && theme.customLevels.length) {
      return theme.customLevels.map(function (lvl) {
        var words = lvl.wordIds.map(function (id) {
          return WORD_BANK.find(function (w) { return w.id === id; });
        }).filter(Boolean);
        return {
          tier: lvl.id, label: lvl.label, lenLabel: null,
          words: words, distractorCount: lvl.distractorCount != null ? lvl.distractorCount : 2
        };
      });
    }
    return DIFFICULTY_TIERS.map(function (tierDef) {
      return {
        tier: tierDef.tier, label: tierDef.label,
        lenLabel: tierDef.minLen === tierDef.maxLen ? (tierDef.minLen + ' 字母') : (tierDef.minLen + '+ 字母'),
        words: getWordsForLevel(themeId, tierDef.tier), distractorCount: tierDef.distractorCount
      };
    });
  }

  // 主題×關卡的「實際可過關」組合——單字數不足 MIN_WORDS_PER_LEVEL 的組合直接排除，
  // 貼紙簿只列出真的打得開的關卡，不然會出現孩子永遠拿不到的灰色格子。這個清單同時
  // 算出正確數量，不寫死一個常數，data.json 未來加字/改字時才不會跟著過期。
  function getValidLevelCombos() {
    var combos = [];
    THEMES.forEach(function (theme) {
      getLevelDefsForTheme(theme.id).forEach(function (def) {
        if (def.words.length >= MIN_WORDS_PER_LEVEL) {
          combos.push({ theme: theme, tierDef: def, key: levelKey(theme.id, def.tier) });
        }
      });
    });
    return combos;
  }

  function shuffleArray(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function pickDistractorLetters(word, count) {
    if (count <= 0) return [];
    var wordLetters = new Set(word.toLowerCase().split(''));
    var pool = new Set();
    WORD_BANK.forEach(function (w) {
      if (w.word === word) return;
      w.word.toLowerCase().split('').forEach(function (ch) {
        if (!wordLetters.has(ch)) pool.add(ch);
      });
    });
    return shuffleArray(Array.from(pool)).slice(0, count);
  }

  function buildTileSet(word, distractorCount) {
    var letters = word.toLowerCase().split('');
    var distractors = pickDistractorLetters(word, distractorCount);
    var all = shuffleArray(letters.concat(distractors));
    var guard = 0;
    while (letters.length > 1 && all.join('') === word && guard < 10) {
      all = shuffleArray(all);
      guard++;
    }
    return all.map(function (ch, i) {
      return { tileId: ch + '_' + i + '_' + Math.random().toString(36).slice(2, 6), letter: ch, used: false };
    });
  }

  // 只有多音節單字（data.json 裡有 syllables 欄位）才回傳分組資訊；
  // 單音節字回傳 null，answer slot 完全不套用分組樣式，維持原本外觀。
  function computeSyllableGrouping(entry) {
    var syllables = entry.syllables;
    if (!syllables || syllables.length <= 1) return null;
    var groupIndex = [];
    var breaks = new Set();
    var pos = 0;
    syllables.forEach(function (syl, gi) {
      if (pos > 0) breaks.add(pos);
      for (var i = 0; i < syl.length; i++) groupIndex.push(gi);
      pos += syl.length;
    });
    return { groupIndex: groupIndex, breaks: breaks };
  }

  // 離開結果畫面（再玩一次／選其他難度／回主選單）時一定要呼叫這個：如果孩子在
  // 開寶箱動畫播完、onLidOpen 回呼觸發之前就點走，沒取消的話貼紙彈窗會晚半秒左右
  // 憑空跳到下一個畫面上面。同時把可能還開著的貼紙彈窗關掉，雙重保險。
  function cancelResultCelebration() {
    if (window.ThreeFX && window.ThreeFX.cancelCelebration) window.ThreeFX.cancelCelebration();
    $('sticker-modal').hidden = true;
  }

  // ---------- Game flow ----------
  function clearPendingGameTimers() {
    if (!gameState) return;
    if (gameState.pendingTimeoutId) {
      clearTimeout(gameState.pendingTimeoutId);
      gameState.pendingTimeoutId = null;
    }
  }

  function startLevel(themeId, tier) {
    clearPendingGameTimers();
    cancelResultCelebration();
    currentThemeId = themeId;
    currentTier = tier;
    var def = getLevelDefsForTheme(themeId).find(function (d) { return d.tier === tier; });
    var words = shuffleArray(def.words);
    gameState = {
      themeId: themeId, tier: tier, distractorCount: def.distractorCount,
      words: words, currentIndex: 0, correctCount: 0, firstTryCorrect: 0,
      totalWrongAttempts: 0, attemptsThisWord: 0, locked: false, pendingTimeoutId: null,
      hintUsedThisWord: false, hintSlotIndex: null, awaitingNext: false,
      syllableGroupIndex: null, syllableBreaks: null,
      slots: [], tiles: [], currentWord: ''
    };
    showView('game');
    loadQuestion();
  }

  function loadQuestion() {
    var entry = gameState.words[gameState.currentIndex];
    gameState.currentWord = entry.word;
    gameState.slots = new Array(entry.word.length).fill(null);
    gameState.tiles = buildTileSet(entry.word, gameState.distractorCount);
    gameState.attemptsThisWord = 0;
    gameState.hintUsedThisWord = false;
    gameState.hintSlotIndex = null;
    gameState.locked = false;
    gameState.pendingTimeoutId = null;
    gameState.awaitingNext = false;
    $('btn-next-question').hidden = true;
    var grouping = computeSyllableGrouping(entry);
    gameState.syllableGroupIndex = grouping ? grouping.groupIndex : null;
    gameState.syllableBreaks = grouping ? grouping.breaks : null;

    var msg = $('feedback-message');
    msg.textContent = '';
    msg.className = 'feedback-message';
    $('game-progress').textContent = '第 ' + (gameState.currentIndex + 1) + ' / ' + gameState.words.length + ' 題';
    $('game-score').textContent = '✅ ' + gameState.correctCount;

    preloadEntryAudio(entry);
    if (gameState.words[gameState.currentIndex + 1]) {
      preloadEntryAudio(gameState.words[gameState.currentIndex + 1]);
    }

    renderPrompt(entry);
    renderAnswerSlots();
    renderTiles();
    updateHintButtonState();

    var hintMode = progress.settings.hintMode;
    if (hintMode === 'audio' || hintMode === 'both') {
      speakWord(entry.word);
    }
  }

  function renderPrompt(entry) {
    var visual = $('prompt-visual');
    visual.innerHTML = '';
    var hintMode = progress.settings.hintMode;
    var showImage = hintMode === 'image' || hintMode === 'both';
    if (showImage) {
      if (entry.emoji) {
        visual.textContent = entry.emoji;
      } else if (entry.swatch) {
        var sw = document.createElement('div');
        sw.className = 'swatch';
        sw.style.background = entry.swatch;
        visual.appendChild(sw);
      }
    } else {
      visual.innerHTML = '<span style="font-size:48px;">👂</span>';
    }
    // 中文提示跟著圖片一起顯示/隱藏：純聽音模式（hintMode 'audio'）刻意不給圖片，
    // 中文翻譯一樣算「看得出答案」的視覺提示，所以這個模式也不顯示，維持只能靠聽的。
    var zhEl = $('prompt-zh');
    if (showImage && entry.zh) {
      zhEl.textContent = entry.zh;
      zhEl.hidden = false;
    } else {
      zhEl.textContent = '';
      zhEl.hidden = true;
    }
    $('btn-speak').style.display = 'inline-block';
  }

  function renderAnswerSlots() {
    var container = $('answer-slots');
    container.innerHTML = '';
    gameState.slots.forEach(function (tileId, idx) {
      var slot = document.createElement('div');
      slot.className = 'answer-slot';
      if (gameState.syllableGroupIndex) {
        slot.classList.add(gameState.syllableGroupIndex[idx] % 2 === 0 ? 'group-a' : 'group-b');
        if (gameState.syllableBreaks.has(idx)) slot.classList.add('group-start');
      }
      if (tileId) {
        var tile = gameState.tiles.find(function (t) { return t.tileId === tileId; });
        slot.textContent = tile.letter;
        slot.classList.add('filled');
        if (idx === gameState.hintSlotIndex) slot.classList.add('hinted');
      }
      slot.addEventListener('click', function () {
        if (gameState.slots[idx]) removeLetterFromSlot(idx);
      });
      container.appendChild(slot);
    });
  }

  function renderTiles() {
    var container = $('tile-area');
    container.innerHTML = '';
    gameState.tiles.forEach(function (tile) {
      var btn = document.createElement('button');
      btn.className = 'letter-tile' + (tile.used ? ' used' : '');
      btn.textContent = tile.letter;
      btn.disabled = tile.used;
      bindTileInteraction(btn, tile.tileId);
      container.appendChild(btn);
    });
  }

  // 主要互動：點擊字母方塊依序填入槽位；輔助互動：Pointer Events 拖曳到指定槽位。
  // 兩種路徑最終都呼叫 placeLetterInSlot，避免邏輯分裂成兩套狀態機。
  function bindTileInteraction(btn, tileId) {
    var startX = 0, startY = 0, moved = false, activePointerId = null;

    btn.addEventListener('pointerdown', function (e) {
      if (btn.disabled) return;
      activePointerId = e.pointerId;
      startX = e.clientX; startY = e.clientY; moved = false;
      try { btn.setPointerCapture(activePointerId); } catch (err) {}
      btn.classList.add('dragging');
    });

    btn.addEventListener('pointermove', function (e) {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (moved) btn.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    });

    btn.addEventListener('pointerup', function (e) {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      btn.classList.remove('dragging');
      btn.style.transform = '';
      if (moved) {
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el.closest('.answer-slot')) placeLetterInSlot(tileId);
      } else {
        placeLetterInSlot(tileId);
      }
      activePointerId = null;
    });

    btn.addEventListener('pointercancel', function () {
      btn.classList.remove('dragging');
      btn.style.transform = '';
      activePointerId = null;
    });
  }

  function placeLetterInSlot(tileId) {
    if (gameState.locked) return;
    var tile = gameState.tiles.find(function (t) { return t.tileId === tileId; });
    if (!tile || tile.used) return;
    var emptyIndex = gameState.slots.findIndex(function (s) { return s === null; });
    if (emptyIndex === -1) return;
    gameState.slots[emptyIndex] = tileId;
    tile.used = true;
    renderAnswerSlots();
    renderTiles();
    if (gameState.slots.every(function (s) { return s !== null; })) {
      checkAnswer();
    }
  }

  function removeLetterFromSlot(slotIndex) {
    if (gameState.locked || slotIndex === gameState.hintSlotIndex) return;
    var tileId = gameState.slots[slotIndex];
    if (!tileId) return;
    var tile = gameState.tiles.find(function (t) { return t.tileId === tileId; });
    tile.used = false;
    gameState.slots[slotIndex] = null;
    renderAnswerSlots();
    renderTiles();
  }

  // 鍵盤輸入：跟點擊字母方塊走同一套 placeLetterInSlot()，不是另一套平行邏輯。
  // 按下的字母可能對應好幾個未用字母方塊（例如重複字母），挑哪一個都一樣，
  // 因為方塊除了字母之外沒有其他可辨識的差異。
  function handleKeyboardLetter(letter) {
    if (!gameState || gameState.locked) return;
    var tile = gameState.tiles.find(function (t) { return !t.used && t.letter === letter; });
    if (!tile) return;
    placeLetterInSlot(tile.tileId);
  }

  // Backspace／Delete：刪掉「目前最後一個已填的格子」，模擬打字刪除最後一個字。
  // 格子一律由左往右依序填入（placeLetterInSlot 永遠找第一個空格），所以「最後一個
  // 已填格」就等於「最後輸入的字母」。已提示的格子跟點擊移除一樣不能刪
  // （removeLetterFromSlot 本身就擋住了），這裡不用另外判斷。
  function handleKeyboardBackspace() {
    if (!gameState || gameState.locked) return;
    for (var i = gameState.slots.length - 1; i >= 0; i--) {
      if (gameState.slots[i] !== null) {
        removeLetterFromSlot(i);
        return;
      }
    }
  }

  // 提示安全閥：每題限用一次，自動把「下一個空格」填入正確字母，
  // 效果等同一次答錯重試 —— 不算首次答對、會讓該題無法拿到 3 星。
  function useHint() {
    if (!gameState || gameState.locked || gameState.hintUsedThisWord) return;
    var emptyIndex = gameState.slots.findIndex(function (s) { return s === null; });
    if (emptyIndex === -1) return;
    var entry = gameState.words[gameState.currentIndex];
    var neededLetter = entry.word[emptyIndex];
    var tile = gameState.tiles.find(function (t) { return !t.used && t.letter === neededLetter; });
    if (!tile) return;
    gameState.hintUsedThisWord = true;
    gameState.hintSlotIndex = emptyIndex;
    gameState.totalWrongAttempts++;
    updateHintButtonState();
    placeLetterInSlot(tile.tileId);
  }

  function updateHintButtonState() {
    var btn = $('btn-hint');
    var used = !!(gameState && gameState.hintUsedThisWord);
    btn.disabled = used;
    btn.classList.toggle('used', used);
  }

  function checkAnswer() {
    gameState.locked = true;
    gameState.attemptsThisWord++;
    var filled = gameState.slots.map(function (tileId) {
      return gameState.tiles.find(function (t) { return t.tileId === tileId; }).letter;
    }).join('');
    var entry = gameState.words[gameState.currentIndex];
    var isCorrect = filled === entry.word;
    recordAnswer(gameState.themeId, gameState.tier, entry.id, isCorrect);
    if (isCorrect) {
      if (gameState.attemptsThisWord === 1 && !gameState.hintUsedThisWord) gameState.firstTryCorrect++;
      handleCorrect(entry);
    } else {
      gameState.totalWrongAttempts++;
      handleWrong(entry);
    }
  }

  function handleCorrect(entry) {
    gameState.correctCount++;
    $('game-score').textContent = '✅ ' + gameState.correctCount;
    document.querySelectorAll('.answer-slot').forEach(function (s) { s.classList.add('correct-flash'); });
    var msg = $('feedback-message');
    msg.textContent = PRAISE_MESSAGES[Math.floor(Math.random() * PRAISE_MESSAGES.length)];
    msg.className = 'feedback-message correct';
    playCorrectSound();
    mascotReactCorrect();
    // 進得了拼字關卡就代表 three.js 已經確認可用（見「開始遊戲」的硬性門檻檢查），
    // 這裡的 if 純粹防禦，理論上不會走到 else。
    if (window.ThreeFX) window.ThreeFX.celebrateCorrect();
    // 答對後不自動倒數切題，停在原題目讓孩子看清楚正確拼法，改成等孩子自己按
    // 「下一題」按鈕或空白鍵才前進（見 bindStaticEvents 的 keydown 監聽）。
    gameState.awaitingNext = true;
    $('btn-next-question').hidden = false;
  }

  // 「下一題」按鈕與空白鍵共用這個入口。
  function proceedFromCorrect() {
    if (!gameState || !gameState.awaitingNext) return;
    gameState.awaitingNext = false;
    $('btn-next-question').hidden = true;
    nextQuestionOrFinish();
  }

  function handleWrong(entry) {
    document.querySelectorAll('.answer-slot').forEach(function (s) { s.classList.add('shake'); });
    var msg = $('feedback-message');
    msg.textContent = ENCOURAGE_MESSAGES[Math.floor(Math.random() * ENCOURAGE_MESSAGES.length)];
    msg.className = 'feedback-message wrong';
    playWrongSound();
    gameState.pendingTimeoutId = setTimeout(resetSlotsKeepTiles, 500);
  }

  function resetSlotsKeepTiles() {
    gameState.pendingTimeoutId = null;
    gameState.locked = false;
    // 已提示的格子在重試時要保留，不然孩子等於白花了唯一一次提示機會
    gameState.slots = gameState.slots.map(function (tileId, idx) {
      return idx === gameState.hintSlotIndex ? tileId : null;
    });
    var hintedTileId = gameState.hintSlotIndex !== null ? gameState.slots[gameState.hintSlotIndex] : null;
    gameState.tiles.forEach(function (t) { t.used = (t.tileId === hintedTileId); });
    renderAnswerSlots();
    renderTiles();
  }

  function nextQuestionOrFinish() {
    gameState.currentIndex++;
    if (gameState.currentIndex >= gameState.words.length) {
      finishLevel();
    } else {
      loadQuestion();
    }
  }

  function calcStars(firstTryCorrect, total, wrongAttempts) {
    var accuracy = firstTryCorrect / total;
    if (accuracy === 1 && wrongAttempts === 0) return 3;
    if (accuracy >= 0.8) return 2;
    if (accuracy >= 0.5) return 1;
    return 0;
  }

  function finishLevel() {
    var total = gameState.words.length;
    var accuracy = gameState.firstTryCorrect / total;
    var stars = calcStars(gameState.firstTryCorrect, total, gameState.totalWrongAttempts);
    var key = levelKey(gameState.themeId, gameState.tier);
    // 一定要在 finalizeLevelRun() 覆寫 bestStars 之前先讀出舊值，不然這裡讀到的
    // 已經是這次剛寫入的新分數，永遠判斷成「首次三星」，貼紙揭曉動畫會每次都重播。
    var prevBestStars = progress.levels[key] ? progress.levels[key].bestStars : 0;
    var isNewSticker = stars === 3 && prevBestStars < 3 && !progress.collectibles[key];
    finalizeLevelRun(gameState.themeId, gameState.tier, accuracy, stars);
    if (isNewSticker) {
      progress.collectibles[key] = true;
      saveProgress();
    }
    // 一定要先切到結果畫面再渲染星星，不然 view 還是 hidden（display:none）時
    // CSS 動畫不會播放，只會直接跳到動畫終點，星星「蹦出」的效果就消失了。
    showView('result');
    renderResult(stars, accuracy, isNewSticker);
  }

  function renderResult(stars, accuracy, isNewSticker) {
    renderStarReveal(stars);
    $('result-accuracy').textContent = '第一次答對率：' + Math.round(accuracy * 100) + '%';
    var pool = RESULT_MESSAGES[stars];
    $('result-message').textContent = pool[Math.floor(Math.random() * pool.length)];
    mascotReact('cheer');
    if (!window.ThreeFX) return; // 防禦：理論上進得了關卡就代表 three.js 可用
    if (isNewSticker) {
      var themeId = currentThemeId, tier = currentTier;
      window.ThreeFX.celebrateChestOpen(function () { showStickerPopup(themeId, tier); });
    } else {
      window.ThreeFX.celebrateLevelComplete();
    }
  }

  // 首次三星過關的貼紙揭曉彈窗；時機由 three-fx.js 的開寶箱動畫透過回呼決定，
  // 不用 app.js 自己猜一個 setTimeout 延遲。
  function showStickerPopup(themeId, tier) {
    var theme = THEMES.find(function (t) { return t.id === themeId; });
    var def = getLevelDefsForTheme(themeId).find(function (d) { return d.tier === tier; });
    if (!theme || !def) return;
    $('sticker-icon').textContent = theme.icon;
    $('sticker-name').textContent = theme.name + ' · ' + def.label;
    $('sticker-modal').hidden = false;
  }

  // 星星逐顆蹦出，搭配音效，比一次性顯示文字更有「過關」的戲劇性堆疊感
  function renderStarReveal(stars) {
    var container = $('result-stars');
    container.innerHTML = '';
    for (var i = 0; i < 3; i++) {
      var span = document.createElement('span');
      span.className = 'result-star-item';
      span.textContent = i < stars ? '⭐' : '☆';
      span.style.animationDelay = (i * 0.35) + 's';
      container.appendChild(span);
      if (i < stars) {
        (function (delay) { setTimeout(playStarPopSound, delay); })(i * 350 + 250);
      }
    }
  }

  // ---------- 音訊快取與預載入 ----------
  var preloadedAudioMap = {};
  function preloadAudio(url) {
    if (!url || preloadedAudioMap[url]) return;
    var audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    preloadedAudioMap[url] = audio;
  }

  function preloadEntryAudio(entry) {
    if (!entry) return;
    if (entry.word) {
      preloadAudio('words-audio/' + encodeURIComponent(entry.word.toLowerCase()) + '.mp3');
    }
    if (entry.phonics && entry.phonics.chunks) {
      entry.phonics.chunks.forEach(function (chunk) {
        preloadAudio('phonics-audio/' + encodeURIComponent(chunk) + '.mp3');
      });
    }
  }

  // ---------- 真人神經語音與語音合成 ----------
  var wordAudioEl = null;

  function initVoices() {
    if (!('speechSynthesis' in window)) return;
    var pick = function () {
      var voices = speechSynthesis.getVoices();
      cachedEnglishVoice = voices.find(function (v) { return v.lang && v.lang.toLowerCase().indexOf('en') === 0; }) || null;
    };
    pick();
    speechSynthesis.addEventListener('voiceschanged', pick);
  }

  function speakWord(word, onEnded) {
    if (!word) {
      if (onEnded) onEnded();
      return;
    }
    var normalizedWord = word.trim().toLowerCase();
    var rate = progress.settings.speechRate || 1.0;

    if (!wordAudioEl) wordAudioEl = new Audio();
    wordAudioEl.playbackRate = rate;

    // 清理舊的監聽器
    wordAudioEl.onended = null;
    wordAudioEl.onerror = null;

    var audioSrc = 'words-audio/' + encodeURIComponent(normalizedWord) + '.mp3';

    var fallbackToTTS = function () {
      if (!('speechSynthesis' in window)) {
        if (onEnded) onEnded();
        return;
      }
      try {
        speechSynthesis.cancel();
        var utter = new SpeechSynthesisUtterance(word);
        if (cachedEnglishVoice) {
          utter.voice = cachedEnglishVoice;
          utter.lang = cachedEnglishVoice.lang;
        }
        utter.rate = rate;
        if (onEnded) {
          utter.onend = onEnded;
          utter.onerror = onEnded;
        }
        speechSynthesis.speak(utter);
      } catch (err) {
        if (onEnded) onEnded();
      }
    };

    wordAudioEl.src = audioSrc;
    wordAudioEl.onended = function () {
      if (onEnded) onEnded();
    };
    wordAudioEl.onerror = function () {
      fallbackToTTS();
    };

    var playPromise = wordAudioEl.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch(function () {
        fallbackToTTS();
      });
    }
  }

  // 每次呼叫 speakPhonics() 就發一個新的序號；播放序列裡每一步都檢查序號還是不是
  // 當下最新的一次，不是的話就直接停止——這是 Audio 版本的「取消前一次播放」機制。
  var phonicsPlaybackId = 0;
  var phonicsAudioEl = null;
  var phonicsAudioStepHandler = null;

  // 依序播放單字的自然發音拆解（高品質神經網路真人發音），最後再播放完整單字真人發音
  function speakPhonics(entry) {
    var phonics = entry.phonics;
    if (!phonics || !phonics.chunks || phonics.chunks.length === 0) { speakWord(entry.word); return; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (wordAudioEl) {
      wordAudioEl.pause();
      wordAudioEl.currentTime = 0;
    }
    var myPlaybackId = ++phonicsPlaybackId;
    if (!phonicsAudioEl) phonicsAudioEl = new Audio();
    if (phonicsAudioStepHandler) {
      phonicsAudioEl.removeEventListener('ended', phonicsAudioStepHandler);
      phonicsAudioEl.removeEventListener('error', phonicsAudioStepHandler);
      phonicsAudioStepHandler = null;
    }
    var chunks = phonics.chunks.filter(function (chunk, i) {
      return !(phonics.silent && phonics.silent.indexOf(i) !== -1);
    });
    var idx = 0;
    var rate = progress.settings.speechRate || 1.0;
    phonicsAudioEl.playbackRate = rate;

    function playNext() {
      if (myPlaybackId !== phonicsPlaybackId) return;
      if (idx >= chunks.length) { speakWord(entry.word); return; }
      var advanced = false;
      var step = function () {
        if (advanced) return;
        advanced = true;
        phonicsAudioEl.removeEventListener('ended', step);
        phonicsAudioEl.removeEventListener('error', step);
        if (phonicsAudioStepHandler === step) phonicsAudioStepHandler = null;
        playNext();
      };
      phonicsAudioStepHandler = step;
      phonicsAudioEl.src = 'phonics-audio/' + encodeURIComponent(chunks[idx]) + '.mp3';
      phonicsAudioEl.playbackRate = rate;
      idx++;
      phonicsAudioEl.addEventListener('ended', step);
      phonicsAudioEl.addEventListener('error', step);
      phonicsAudioEl.play().catch(step);
    }
    playNext();
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if ('speechSynthesis' in window) {
      try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (err) {}
    }
    initAudioContext();

    if (!wordAudioEl) wordAudioEl = new Audio();
    if (!phonicsAudioEl) phonicsAudioEl = new Audio();

    wordAudioEl.muted = true;
    wordAudioEl.src = 'words-audio/cat.mp3';
    var p1 = wordAudioEl.play();
    if (p1 && typeof p1.then === 'function') {
      p1.then(function () {
        wordAudioEl.pause();
        wordAudioEl.currentTime = 0;
        wordAudioEl.muted = false;
      }).catch(function () { wordAudioEl.muted = false; });
    } else {
      wordAudioEl.muted = false;
    }

    phonicsAudioEl.muted = true;
    phonicsAudioEl.src = 'phonics-audio/a.mp3';
    var p2 = phonicsAudioEl.play();
    if (p2 && typeof p2.then === 'function') {
      p2.then(function () {
        phonicsAudioEl.pause();
        phonicsAudioEl.currentTime = 0;
        phonicsAudioEl.muted = false;
      }).catch(function () { phonicsAudioEl.muted = false; });
    } else {
      phonicsAudioEl.muted = false;
    }
  }

  // ---------- Web Audio synthesized sound effects ----------
  function initAudioContext() {
    if (audioCtx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playTone(freq, duration, delay) {
    if (!progress.settings.soundEnabled || !audioCtx) return;
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    var t0 = audioCtx.currentTime + delay;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function playCorrectSound() {
    playTone(523.25, 0.12, 0);
    playTone(659.25, 0.12, 0.1);
    playTone(783.99, 0.16, 0.2);
  }

  function playWrongSound() {
    playTone(196, 0.25, 0);
  }

  function playStarPopSound() {
    playTone(1046.5, 0.14, 0);
  }

  // ---------- Theme / level / progress rendering ----------
  function renderThemeGrid() {
    var grid = $('theme-grid');
    grid.innerHTML = '';
    THEMES.forEach(function (theme) {
      var totalStars = 0, maxStars = 0;
      getLevelDefsForTheme(theme.id).forEach(function (def) {
        if (def.words.length < MIN_WORDS_PER_LEVEL) return;
        maxStars += 3;
        var lp = progress.levels[levelKey(theme.id, def.tier)];
        totalStars += lp ? lp.bestStars : 0;
      });
      var btn = document.createElement('button');
      btn.className = 'theme-card';
      btn.style.background = theme.color;
      btn.innerHTML = '<span class="theme-icon">' + theme.icon + '</span>' + theme.name +
        '<span class="theme-stars">⭐ ' + totalStars + '/' + maxStars + '</span>';
      btn.addEventListener('click', function () {
        if (themeSelectMode === 'browse') {
          openFlashcards(getAllWordsForTheme(theme.id), { origin: 'theme-select' });
        } else if (themeSelectMode === 'blend') {
          openBlendGame(theme.id);
        } else {
          showLevelSelect(theme.id);
        }
      });
      grid.appendChild(btn);
    });
  }

  function getAllWordsForTheme(themeId) {
    return WORD_BANK.filter(function (w) { return w.theme === themeId; });
  }

  function showLevelSelect(themeId) {
    currentThemeId = themeId;
    var theme = THEMES.find(function (t) { return t.id === themeId; });
    $('level-select-title').textContent = theme.icon + ' ' + theme.name + ' - 選難度';
    renderLevelGrid(themeId);
    renderHintModeButtons();
    showView('level-select');
  }

  function renderLevelGrid(themeId) {
    var grid = $('level-grid');
    grid.innerHTML = '';
    getLevelDefsForTheme(themeId).forEach(function (def) {
      var words = def.words;
      var lp = progress.levels[levelKey(themeId, def.tier)];
      var stars = lp ? lp.bestStars : 0;
      var disabled = words.length < MIN_WORDS_PER_LEVEL;
      var labelText = def.lenLabel ? (def.label + '（' + def.lenLabel + '）') : (def.label + '（' + words.length + ' 字）');
      var accuracyText = lp && lp.attempts > 0 ? ('最佳正確率 ' + Math.round(lp.bestAccuracy * 100) + '%') : '尚未挑戰';

      var card = document.createElement('div');
      card.className = 'level-card' + (disabled ? ' disabled' : '');

      var info = document.createElement('div');
      info.className = 'level-info';
      info.innerHTML = '<span>' + labelText + '</span>' +
        '<span class="level-stars">' + '⭐'.repeat(stars) + '☆'.repeat(3 - stars) + '</span>' +
        '<span class="level-accuracy">' + accuracyText + '</span>';
      card.appendChild(info);

      var actions = document.createElement('div');
      actions.className = 'level-actions';

      var previewBtn = document.createElement('button');
      previewBtn.className = 'btn level-preview-btn';
      previewBtn.title = '先看看這些單字';
      previewBtn.textContent = '📖';
      previewBtn.disabled = disabled;
      previewBtn.addEventListener('click', function () {
        openFlashcards(words, { origin: 'level-select' });
      });
      actions.appendChild(previewBtn);

      var startBtn = document.createElement('button');
      startBtn.className = 'btn level-start-btn';
      startBtn.textContent = '開始';
      startBtn.disabled = disabled;
      startBtn.addEventListener('click', function () { startLevel(themeId, def.tier); });
      actions.appendChild(startBtn);

      card.appendChild(actions);
      grid.appendChild(card);
    });
  }

  // ---------- Flashcards (學習/預習模式，不計分、不記錄進度) ----------
  function openFlashcards(words, opts) {
    if (!words || words.length === 0) return;
    flashcardsState = { words: words, index: 0, origin: opts.origin };
    renderFlashcard();
    showView('flashcards');
  }

  function renderFlashcard() {
    var entry = flashcardsState.words[flashcardsState.index];
    var visual = $('flashcard-visual');
    visual.innerHTML = '';
    // 字卡模式固定同時顯示圖片＋完整拼法＋發音，不受測驗的「提示模式」設定影響
    if (entry.emoji) {
      visual.textContent = entry.emoji;
    } else if (entry.swatch) {
      var sw = document.createElement('div');
      sw.className = 'swatch';
      sw.style.background = entry.swatch;
      visual.appendChild(sw);
    }
    $('flashcard-word').textContent = entry.word;
    var syllablesEl = $('flashcard-syllables');
    if (entry.syllables && entry.syllables.length > 1) {
      syllablesEl.textContent = entry.syllables.join('-');
      syllablesEl.hidden = false;
    } else {
      syllablesEl.textContent = '';
      syllablesEl.hidden = true;
    }
    var phonicsEl = $('flashcard-phonics');
    if (entry.phonics && entry.phonics.chunks && entry.phonics.chunks.length > 1) {
      var htmlParts = entry.phonics.chunks.map(function (chunk, i) {
        var isSilent = entry.phonics.silent && entry.phonics.silent.indexOf(i) !== -1;
        return isSilent ? '<span class="silent-chunk">(' + chunk + ')</span>' : chunk;
      });
      phonicsEl.innerHTML = htmlParts.join('-');
      phonicsEl.hidden = false;
    } else {
      phonicsEl.innerHTML = '';
      phonicsEl.hidden = true;
    }
    $('flashcard-position').textContent = (flashcardsState.index + 1) + ' / ' + flashcardsState.words.length;
    $('btn-flashcard-prev').disabled = flashcardsState.index === 0;
    $('btn-flashcard-next').disabled = flashcardsState.index === flashcardsState.words.length - 1;
    $('btn-flashcard-speak').style.display = 'inline-block';
    $('btn-flashcard-blend').style.display = 'inline-block';

    preloadEntryAudio(entry);
    if (flashcardsState.words[flashcardsState.index + 1]) {
      preloadEntryAudio(flashcardsState.words[flashcardsState.index + 1]);
    }

    // 快速連按上一個/下一個時要 debounce，不然連續呼叫 speakWord 在部分瀏覽器
    // （尤其 iOS Safari）會排隊卡住、唸出一堆斷斷續續的半音節。只在孩子停下來的那張卡唸。
    clearTimeout(flashcardSpeakTimer);
    flashcardSpeakTimer = setTimeout(function () { speakWord(entry.word); }, 250);
  }

  // ---------- Blend game (拼讀練習，學習練習性質，不計分、不記錄進度) ----------
  function openBlendGame(themeId) {
    var words = getAllWordsForTheme(themeId);
    if (words.length < 3) {
      showToast('這個主題單字不夠，無法進行拼讀練習');
      return;
    }
    blendState = { themeId: themeId, pool: words, current: null, choices: [], locked: false, pendingTimeoutId: null };
    showView('blend');
    loadBlendQuestion();
  }

  function loadBlendQuestion() {
    var pool = blendState.pool;
    var target = pool[Math.floor(Math.random() * pool.length)];
    var distractorPool = pool.filter(function (w) { return w.id !== target.id; });
    var distractors = shuffleArray(distractorPool).slice(0, Math.min(2, distractorPool.length));
    blendState.current = target;
    blendState.choices = shuffleArray([target].concat(distractors));
    blendState.locked = false;
    blendState.pendingTimeoutId = null;
    var msg = $('blend-feedback');
    msg.textContent = '';
    msg.className = 'feedback-message';
    preloadEntryAudio(target);
    renderBlendChoices();
    speakPhonics(target);
  }

  function renderBlendChoices() {
    var container = $('blend-choices');
    container.innerHTML = '';
    blendState.choices.forEach(function (entry) {
      var btn = document.createElement('button');
      btn.className = 'blend-choice';

      var visual = document.createElement('div');
      visual.className = 'blend-choice-visual';
      if (entry.emoji) {
        visual.textContent = entry.emoji;
      } else if (entry.swatch) {
        var sw = document.createElement('div');
        sw.className = 'swatch';
        sw.style.background = entry.swatch;
        visual.appendChild(sw);
      }
      btn.appendChild(visual);

      var wordEl = document.createElement('div');
      wordEl.className = 'blend-choice-word';
      wordEl.textContent = entry.word;
      btn.appendChild(wordEl);

      btn.addEventListener('click', function () { handleBlendChoice(entry, btn); });
      container.appendChild(btn);
    });
  }

  function handleBlendChoice(entry, btnEl) {
    if (blendState.locked || btnEl.disabled) return;
    var isCorrect = entry.id === blendState.current.id;
    var msg = $('blend-feedback');
    if (isCorrect) {
      blendState.locked = true;
      btnEl.classList.add('correct-flash');
      msg.textContent = PRAISE_MESSAGES[Math.floor(Math.random() * PRAISE_MESSAGES.length)];
      msg.className = 'feedback-message correct';
      playCorrectSound();
      mascotReactCorrect();
      // 拼讀練習不受「開始遊戲」的 three.js 硬性門檻限制（跟字卡瀏覽一樣不依賴 3D 特效），
      // 所以這裡不能假設 window.ThreeFX 一定存在，沒有就單純跳過特效，不影響作答功能。
      if (window.ThreeFX) window.ThreeFX.celebrateCorrect();
      blendState.pendingTimeoutId = setTimeout(loadBlendQuestion, 1400);
    } else {
      btnEl.classList.add('shake');
      btnEl.disabled = true; // 排除這個選項，孩子可以繼續嘗試其他選項，不計對錯、沒有壓力
      setTimeout(function () { btnEl.classList.remove('shake'); }, 400);
      msg.textContent = ENCOURAGE_MESSAGES[Math.floor(Math.random() * ENCOURAGE_MESSAGES.length)];
      msg.className = 'feedback-message wrong';
      playWrongSound();
    }
  }

  function renderHintModeButtons() {
    document.querySelectorAll('#hint-mode-buttons .btn-toggle').forEach(function (b) {
      b.classList.toggle('active', b.dataset.hintMode === progress.settings.hintMode);
    });
    document.querySelectorAll('#sound-toggle-buttons .btn-toggle').forEach(function (b) {
      b.classList.toggle('active', (b.dataset.soundEnabled === 'true') === progress.settings.soundEnabled);
    });
    document.querySelectorAll('#speech-rate-buttons .btn-toggle').forEach(function (b) {
      b.classList.toggle('active', parseFloat(b.dataset.speechRate) === progress.settings.speechRate);
    });
  }

  function renderProgressTable() {
    var container = $('progress-table');
    container.innerHTML = '';
    getValidLevelCombos().forEach(function (combo) {
      var lp = progress.levels[combo.key];
      var stars = lp ? lp.bestStars : 0;
      var accuracyText = lp && lp.attempts > 0 ? (Math.round(lp.bestAccuracy * 100) + '%') : '未挑戰';
      var row = document.createElement('div');
      row.className = 'progress-row';
      row.innerHTML = '<span class="progress-theme-name">' + combo.theme.icon + ' ' + combo.theme.name + '</span>' +
        '<span class="progress-tier">' + combo.tierDef.label + '</span>' +
        '<span>' + '⭐'.repeat(stars) + '☆'.repeat(3 - stars) + '</span>' +
        '<span>' + accuracyText + '</span>';
      container.appendChild(row);
    });
  }

  // 貼紙簿：只列出「實際打得開」的組合，已拿到貼紙的顯示主題 icon，還沒拿到的用問號佔位。
  function renderCollectiblesGrid() {
    var container = $('collectibles-grid');
    container.innerHTML = '';
    getValidLevelCombos().forEach(function (combo) {
      var collected = !!progress.collectibles[combo.key];
      var item = document.createElement('div');
      item.className = 'sticker-item' + (collected ? ' collected' : ' locked');
      item.innerHTML = '<span class="sticker-item-icon">' + (collected ? combo.theme.icon : '❔') + '</span>' +
        '<span class="sticker-item-label">' + combo.theme.name + ' ' + combo.tierDef.label + '</span>';
      container.appendChild(item);
    });
  }

  // ---------- Event bindings ----------
  function bindStaticEvents() {
    // DOM 剛 ready 時，three-fx.js 的 ready/error 事件搞不好已經先觸發過了
    // （它是同步執行的 IIFE 監聽器，可能比這裡早），所以要在這裡補套用一次目前狀態，
    // 不然按鈕會停在 HTML 預設的「準備中...」文字，即使 three.js 其實已經判定完成。
    applyThreeFxGateToStartButton();

    document.querySelectorAll('[data-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.dataset.nav;
        cancelResultCelebration();
        if (target === 'theme-select') renderThemeGrid();
        if (target === 'progress') { renderProgressTable(); renderCollectiblesGrid(); }
        showView(target);
      });
    });

    $('btn-start').addEventListener('click', function () {
      unlockAudio();
      themeSelectMode = 'quiz';
      renderThemeGrid();
      showView('theme-select');
    });

    $('btn-flashcards').addEventListener('click', function () {
      unlockAudio();
      themeSelectMode = 'browse';
      renderThemeGrid();
      showView('theme-select');
    });

    $('btn-blend').addEventListener('click', function () {
      unlockAudio();
      themeSelectMode = 'blend';
      renderThemeGrid();
      showView('theme-select');
    });

    $('btn-blend-back').addEventListener('click', function () {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      if (blendState && blendState.pendingTimeoutId) clearTimeout(blendState.pendingTimeoutId);
      blendState = null;
      renderThemeGrid();
      showView('theme-select');
    });

    $('btn-blend-replay').addEventListener('click', function () {
      if (blendState && blendState.current) speakPhonics(blendState.current);
    });

    $('btn-flashcard-back').addEventListener('click', function () {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      clearTimeout(flashcardSpeakTimer);
      if (flashcardsState && flashcardsState.origin === 'level-select') {
        // 不需要重新 renderLevelGrid()：字卡瀏覽不寫入任何進度，離開時關卡列表的
        // 星等/正確率跟進入前完全一樣。之後若字卡模式加了「標記已學會」之類會
        // 改變進度的功能，這裡就要補上重新渲染，否則會看到舊的星等。
        showView('level-select');
      } else {
        renderThemeGrid();
        showView('theme-select');
      }
    });

    $('btn-flashcard-prev').addEventListener('click', function () {
      if (flashcardsState.index > 0) {
        flashcardsState.index--;
        renderFlashcard();
      }
    });

    $('btn-flashcard-next').addEventListener('click', function () {
      if (flashcardsState.index < flashcardsState.words.length - 1) {
        flashcardsState.index++;
        renderFlashcard();
      }
    });

    $('btn-flashcard-speak').addEventListener('click', function () {
      if (flashcardsState) speakWord(flashcardsState.words[flashcardsState.index].word);
    });

    $('btn-flashcard-blend').addEventListener('click', function () {
      if (flashcardsState) speakPhonics(flashcardsState.words[flashcardsState.index]);
    });

    $('btn-progress').addEventListener('click', function () {
      renderProgressTable();
      renderCollectiblesGrid();
      showView('progress');
    });

    $('sticker-modal-close').addEventListener('click', function () { $('sticker-modal').hidden = true; });
    $('sticker-modal').addEventListener('click', function (e) {
      if (e.target.id === 'sticker-modal') $('sticker-modal').hidden = true;
    });

    $('btn-retry-load').addEventListener('click', loadGameData);

    $('btn-speak').addEventListener('click', function () {
      if (gameState) speakWord(gameState.currentWord);
    });

    $('btn-hint').addEventListener('click', useHint);

    $('btn-next-question').addEventListener('click', proceedFromCorrect);

    // 鍵盤操作：跟滑鼠/觸控並行的輸入方式，不用另外 focus 任何元素，依「目前
    // 顯示哪個畫面」決定按鍵的意義，避免跟其他畫面的按鍵/快捷鍵衝突。
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!$('view-game').hidden) {
        // 答對後停在原題目等使用者操作，空白鍵是「下一題」按鈕的鍵盤捷徑；
        // 其餘時候（還在拼這一題）空白鍵不處理，避免不小心觸發瀏覽器的捲動。
        if (e.key === ' ' || e.code === 'Space') {
          if (gameState && gameState.awaitingNext) {
            e.preventDefault();
            proceedFromCorrect();
          }
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          handleKeyboardBackspace();
        } else if (/^[a-zA-Z]$/.test(e.key)) {
          handleKeyboardLetter(e.key.toLowerCase());
        }
      } else if (!$('view-flashcards').hidden) {
        // 按鈕本身已經有 disabled 邊界檢查（第一張/最後一張），直接呼叫
        // .click() 重用同一套邏輯，disabled 的按鈕呼叫 .click() 瀏覽器不會觸發事件。
        if (e.key === 'ArrowLeft') { e.preventDefault(); $('btn-flashcard-prev').click(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); $('btn-flashcard-next').click(); }
      }
    });

    $('btn-leave-game').addEventListener('click', function () {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      clearPendingGameTimers();
      cancelResultCelebration();
      showView('level-select');
    });

    $('hint-mode-buttons').addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-toggle');
      if (!btn) return;
      progress.settings.hintMode = btn.dataset.hintMode;
      saveProgress();
      renderHintModeButtons();
    });

    $('sound-toggle-buttons').addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-toggle');
      if (!btn) return;
      progress.settings.soundEnabled = btn.dataset.soundEnabled === 'true';
      saveProgress();
      renderHintModeButtons();
    });

    $('speech-rate-buttons').addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-toggle');
      if (!btn) return;
      progress.settings.speechRate = parseFloat(btn.dataset.speechRate);
      saveProgress();
      renderHintModeButtons();
      speakWord(gameState ? gameState.currentWord : 'hello'); // 立即試聽，讓孩子聽出速度差異
    });

    $('btn-replay').addEventListener('click', function () { startLevel(currentThemeId, currentTier); });
    $('btn-back-levels').addEventListener('click', function () {
      cancelResultCelebration();
      showLevelSelect(currentThemeId);
    });

    $('btn-export').addEventListener('click', exportProgress);
    $('btn-import').addEventListener('click', function () { $('import-file-input').click(); });
    $('import-file-input').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (file) importProgressFile(file);
      e.target.value = '';
    });

    $('btn-check-threefx').addEventListener('click', checkThreeFxStatus);
  }

  // 直接檢查 window.ThreeFX 是否存在，不透過事件/timeout 猜測——這是最可靠的判斷方式，
  // 不會受到「特效載入失敗」提示那套（曾經有時序 bug 的）偵測邏輯影響。
  // 順便觸發一次真正的特效播放，讓使用者能立刻親眼確認是 3D 版還是 CSS 備援版在跑。
  function checkThreeFxStatus() {
    var statusEl = $('threefx-status-text');
    if (window.ThreeFX) {
      statusEl.textContent = '✅ 3D 特效目前可以使用';
      statusEl.className = 'threefx-status ok';
      window.ThreeFX.celebrateLevelComplete();
    } else {
      statusEl.textContent = '❌ 3D 特效目前無法使用，拼字遊戲關卡暫時無法進入（字卡瀏覽／拼讀練習不受影響）';
      statusEl.className = 'threefx-status fail';
    }
  }

  // three.js 現在是拼字關卡的硬性需求，不再是「失敗就退回 CSS 特效」的裝飾性強化——
  // 拼字關卡的答對/過關特效都改成純 three.js 呈現，沒有 CSS 備援版本。所以「開始遊戲」
  // 按鈕要等 three-fx.js 明確回報成功或失敗才能決定開放，避免孩子點進去之後才發現特效
  // 播不出來。字卡瀏覽、拼讀練習、進度頁完全不依賴 three.js，不受這個門檻限制。
  //
  // three-fx.js 會明確送出 'threefx-ready' / 'threefx-error' 事件，不靠猜測的固定等待時間
  // 判斷是否載入完成——CDN 要下載完整個 three.js 函式庫，在較慢的網路下可能超過好幾秒，
  // 用固定 timeout 猜會在正常情況下誤判成失敗。module script 本身載入失敗（例如 CDN 被擋）
  // 則由 <script> 的 error 事件補上；兩者都沒發生時才用一個夠長的保底 timeout 兜底。
  var threeFxSettled = false;
  var threeFxState = 'pending'; // 'pending' | 'ready' | 'unavailable'

  function applyThreeFxGateToStartButton() {
    var btn = $('btn-start');
    if (!btn) return; // DOM 還沒 ready，晚點 bindStaticEvents() 會再套用一次目前狀態
    if (threeFxState === 'ready') {
      btn.disabled = false;
      btn.textContent = '▶️ 開始遊戲';
      btn.title = '';
    } else if (threeFxState === 'unavailable') {
      btn.disabled = true;
      btn.textContent = '▶️ 開始遊戲（此裝置不支援）';
      btn.title = '這台裝置或瀏覽器不支援拼字遊戲需要的 3D 效果，請換一台裝置或瀏覽器再試。字卡瀏覽與拼讀練習不受影響，仍可正常使用。';
    } else {
      btn.disabled = true;
      btn.textContent = '▶️ 準備中...';
      btn.title = '正在確認裝置支援狀況';
    }
  }

  function notifyThreeFxUnavailable() {
    if (threeFxSettled) return;
    threeFxSettled = true;
    threeFxState = 'unavailable';
    // 不用 toast 額外提示——「開始遊戲」按鈕本身會變成 disabled 並顯示說明文字，
    // 這個狀態是永久的（同一台裝置每次都會這樣），toast 每次載入都跳一次只會變成
    // 干擾，按鈕上的文字已經是持續可見、講得更清楚的提示。
    applyThreeFxGateToStartButton();
  }

  // 這兩個監聽器要在這裡（IIFE 最外層、同步執行，不包在 DOMContentLoaded 裡）就註冊，
  // 不能等到 DOMContentLoaded 才註冊。three-fx.js 是 <script type="module">，行為等同
  // defer，通常會在 DOMContentLoaded 觸發「之前」就執行完畢並送出 ready/error 事件；
  // app.js 是排在它前面的一般 <script>，會更早同步執行——在這裡註冊才能保證監聽器
  // 一定搶在 three-fx.js 送出事件之前就位，不然會發生「明明成功了、卻因為監聽器
  // 註冊太晚接不到事件，被 9 秒保底 timeout 誤判成失敗」的假警報。
  window.addEventListener('threefx-ready', function () {
    threeFxSettled = true;
    threeFxState = 'ready';
    applyThreeFxGateToStartButton();
  });
  window.addEventListener('threefx-error', notifyThreeFxUnavailable);

  function setupThreeFxDetection() {
    var moduleScript = document.querySelector('script[type="module"][src="three-fx.js"]');
    if (moduleScript) moduleScript.addEventListener('error', notifyThreeFxUnavailable);
    setTimeout(notifyThreeFxUnavailable, 9000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindStaticEvents();
    loadGameData();
    setupThreeFxDetection();
  });
})();
