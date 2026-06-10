/* ============================================================
   VN-режим для Story Reader  (этап 1)
   Самодостаточный модуль. Подключается одной строкой в story/index.html:
     <script src="/ak-defectiv-tr/js/vn.js" defer></script>
   Переиспускает глобальные функции ридера: uri_character, uri_background,
   uri_sound, ASSET_SOURCE, DATA_BASE (если доступны).
   ============================================================ */
(function () {
  "use strict";

  // ---------- настройки ----------
  var SERVER = "en_US"; // переводы лежат в ветке en_US
  var SPEEDS = [1, 2, 4, 8, 16, 32];
  var TYPE_CPS = 32; // базовая скорость печати, символов/сек при 1x
  var AUTO_DELAY = 1300; // пауза после реплики в авто-режиме (мс) при 1x
  var REMOTE_BASE =
    (typeof DATA_BASE !== "undefined" && DATA_BASE && DATA_BASE[SERVER]) ||
    "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/en";

  // ---------- состояние ----------
  var frames = [];
  var pos = 0;
  var maxReached = -1; // чтобы не переигрывать звук при возврате назад
  var typing = null; // таймер печатной машинки
  var typedFullHtml = ""; // полный HTML текущей реплики (для мгновенного показа)
  var auto = false;
  var autoTimer = null;
  var speedIdx = 0;
  var uiHidden = false;
  var reviewTableCache = null;
  var music = null; // Audio
  var soundMap = {}; // ключ звука -> путь к файлу (из story_variables.json)
  var assetCache = {}; // "sp:name"/"bg:name" -> рабочий URL (после предзагрузки)
  var displayedBg = null; // имя сейчас показанного фона (чтобы не моргал)

  // ---------- утилиты URL (с запасными источниками) ----------
  function spriteUrls(name) {
    var enc = encodeURIComponent(name);
    var out = [];
    try {
      if (typeof uri_character === "function" && typeof ASSET_SOURCE !== "undefined") {
        out.push(uri_character(enc, ASSET_SOURCE.ACESHIP));
        if (ASSET_SOURCE.RAW) out.push(uri_character(enc, ASSET_SOURCE.RAW));
        out.push(uri_character(enc, ASSET_SOURCE.LOCAL));
      }
    } catch (e) {}
    out.push("https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/avg/characters/" + enc + ".png");
    // попытки с упрощённым именем (без #face$body), на случай отсутствия точного арта
    var base = name.split("#")[0];
    out.push("https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/avg/characters/" + encodeURIComponent(base + "#1$1") + ".png");
    return out;
  }
  function bgUrls(image) {
    var enc = encodeURIComponent(image);
    var out = [];
    try {
      if (typeof uri_background === "function" && typeof ASSET_SOURCE !== "undefined") {
        out.push(uri_background(image, ASSET_SOURCE.ACESHIP));
        out.push(uri_background(image, ASSET_SOURCE.LOCAL));
      }
    } catch (e) {}
    out.push("https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/avg/backgrounds/" + enc + ".png");
    return out;
  }
  function soundUrls(key) {
    var soundkey = String(key).replace(/^\$/, "");
    var soundpath = soundMap[soundkey] || soundkey; // перевод ключа в реальный путь
    var out = [];
    try {
      if (typeof uri_sound === "function" && typeof ASSET_SOURCE !== "undefined") {
        out.push(uri_sound(soundpath)); // mp3 (LOCAL)
        out.push(uri_sound(soundpath, ASSET_SOURCE.ACESHIP)); // wav (запасной)
      }
    } catch (e) {}
    return out;
  }

  // картинка с перебором запасных адресов
  function setImgWithFallback(img, urls) {
    var i = 0;
    img.onerror = function () {
      i++;
      if (i < urls.length) img.src = urls[i];
      else img.onerror = null;
    };
    img.src = urls[0];
  }

  // ---------- парсер сценария ----------
  var SLOT = { l: "left", left: "left", m: "center", middle: "center", r: "right", right: "right" };

  function parseArgs(s) {
    var args = {};
    var re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,()]+))/g;
    var m;
    while ((m = re.exec(s))) {
      args[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]).trim();
    }
    return args;
  }

  function parse(txt) {
    var lines = txt.split(/\r?\n/);
    var fr = [];
    var cur = { left: null, center: null, right: null }; // имена спрайтов в слотах
    var focusSlot = null; // 'left'|'center'|'right'|null
    var bg = null;
    var pendingSounds = [];
    var pendingMusic = null; // {key,volume} | 'stop' | null
    var pendingName = null;

    function pushFrame(extra) {
      var snap = {
        left: cur.left ? { name: cur.left, dim: focusSlot && focusSlot !== "left" } : null,
        center: cur.center ? { name: cur.center, dim: focusSlot && focusSlot !== "center" } : null,
        right: cur.right ? { name: cur.right, dim: focusSlot && focusSlot !== "right" } : null,
      };
      var f = {
        bg: bg,
        sprites: snap,
        name: "",
        text: "",
        subtitle: null,
        sounds: pendingSounds.slice(),
        music: pendingMusic,
      };
      for (var k in extra) f[k] = extra[k];
      fr.push(f);
      pendingSounds = [];
      pendingMusic = null;
    }

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!line.trim()) continue;

      // вытащить ведущие теги [...] и хвостовой текст
      var rest = line;
      var tags = [];
      var mm;
      var tagRe = /^\s*\[([^\]]*)\]/;
      while ((mm = tagRe.exec(rest))) {
        tags.push(mm[1]);
        rest = rest.slice(mm[0].length);
      }
      var tail = rest.trim();

      for (var t = 0; t < tags.length; t++) {
        var content = tags[t].trim();
        // форма [name="X"]
        var nm = content.match(/^name\s*=\s*"([^"]*)"$/i);
        if (nm) { pendingName = nm[1]; continue; }

        var paren = content.indexOf("(");
        var cmd = (paren >= 0 ? content.slice(0, paren) : content).trim().toLowerCase();
        var args = paren >= 0 ? parseArgs(content.slice(paren + 1, content.lastIndexOf(")"))) : {};

        if (cmd === "charslot" || cmd === "character") {
          if (paren < 0 || (!args.name && !args.slot && !args.focus)) {
            // пустой [charslot] -> очистить всех
            cur = { left: null, center: null, right: null };
            focusSlot = null;
            continue;
          }
          var slot = SLOT[(args.slot || "").toLowerCase()] || "center";
          if (args.name) cur[slot] = args.name;
          if (args.focus !== undefined) {
            var fv = String(args.focus).toLowerCase();
            if (fv === "none" || fv === "n" || fv === "-1") focusSlot = null;
            else focusSlot = SLOT[fv] || slot;
          }
        } else if (cmd === "background") {
          if (args.image) bg = args.image;
        } else if (cmd === "playmusic") {
          pendingMusic = { key: args.key, volume: parseFloat(args.volume || "0.6") };
        } else if (cmd === "stopmusic") {
          pendingMusic = "stop";
        } else if (cmd === "playsound") {
          if (args.key) pendingSounds.push(args.key);
        } else if (cmd === "subtitle") {
          if (args.text) pushFrame({ subtitle: args.text });
        } else if (cmd === "multiline") {
          if (args.name) pendingName = args.name;
        }
        // прочие теги (Blocker, Delay, CameraShake, Effect, Image и т.п.) — этап 2
      }

      if (tail) {
        pushFrame({ name: pendingName || "", text: tail });
        pendingName = null;
      }
    }
    return fr;
  }

  // ---------- разрешение текущего файла истории ----------
  function getReviewTable() {
    if (reviewTableCache) return Promise.resolve(reviewTableCache);
    return fetch(REMOTE_BASE + "/gamedata/excel/story_review_table.json")
      .then(function (r) { return r.json(); })
      .then(function (j) { reviewTableCache = j; return j; });
  }
  function currentStoryTxtKey() {
    var hash = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    var parts = hash.split("&");
    var storyId = parts[1];
    var idx = parseInt(parts[2] || "0", 10) || 0;
    if (!storyId) return Promise.reject(new Error("В адресе нет истории (открой эпизод в ридере)"));
    // 1) Берём список, который уже построил сам ридер. В нём для некоторых
    //    событий вставлена страница "Introduction" в начало, поэтому индексы
    //    из хеша совпадают именно с этим списком, а не с сырой таблицей.
    try {
      if (typeof storyReview !== "undefined" && storyReview &&
          storyReview[storyId] && storyReview[storyId].infoUnlockDatas) {
        var arr = storyReview[storyId].infoUnlockDatas;
        if (arr[idx] && arr[idx].storyTxt) return Promise.resolve(arr[idx].storyTxt);
      }
    } catch (e) {}
    // 2) Запасной путь: сырая таблица (без Introduction, индексы могут не совпасть).
    return getReviewTable().then(function (table) {
      var entry = table[storyId];
      if (!entry || !entry.infoUnlockDatas || !entry.infoUnlockDatas[idx])
        throw new Error("История не найдена: " + storyId + " #" + idx);
      return entry.infoUnlockDatas[idx].storyTxt;
    });
  }
  function fetchStoryTxt(key) {
    return fetch("../gamedata/" + SERVER + "/story/" + key + ".txt").then(function (r) {
      if (r.ok) return r.text();
      return fetch(REMOTE_BASE + "/gamedata/story/" + key + ".txt").then(function (t) { return t.text(); });
    });
  }

  // ---------- предзагрузка ассетов ----------
  function loadFirst(urls) {
    return new Promise(function (resolve) {
      var i = 0;
      var im = new Image();
      im.onload = function () { resolve(im.src); };
      im.onerror = function () { i++; if (i < urls.length) im.src = urls[i]; else resolve(null); };
      im.src = urls[0];
    });
  }
  function getSoundMap() {
    return fetch(REMOTE_BASE + "/gamedata/story/story_variables.json")
      .then(function (r) { return r.json(); })
      .then(function (j) { soundMap = j || {}; })
      .catch(function () { soundMap = {}; });
  }
  function preloadAssets(onProgress) {
    var jobs = [];
    var seen = {};
    frames.forEach(function (f) {
      if (f.bg && !seen["bg:" + f.bg]) { seen["bg:" + f.bg] = 1; jobs.push({ key: "bg:" + f.bg, urls: bgUrls(f.bg) }); }
      ["left", "center", "right"].forEach(function (s) {
        var sp = f.sprites[s];
        if (sp && !seen["sp:" + sp.name]) { seen["sp:" + sp.name] = 1; jobs.push({ key: "sp:" + sp.name, urls: spriteUrls(sp.name) }); }
      });
    });
    var done = 0, total = jobs.length;
    if (!total) return Promise.resolve();
    return Promise.all(
      jobs.map(function (j) {
        return loadFirst(j.urls).then(function (url) {
          assetCache[j.key] = url || j.urls[0];
          done++;
          if (onProgress) onProgress(done, total);
        });
      })
    );
  }

  // ---------- UI ----------
  var el = {};
  function buildUI() {
    var css = document.createElement("style");
    css.textContent = VN_CSS;
    document.head.appendChild(css);

    var root = document.createElement("div");
    root.id = "vnRoot";
    root.hidden = true;
    root.innerHTML =
      '<div id="vnBgA" class="vnBg"></div>' +
      '<div id="vnBgB" class="vnBg"></div>' +
      '<div id="vnSprites"><div class="vnSlot left"></div><div class="vnSlot center"></div><div class="vnSlot right"></div></div>' +
      '<div id="vnSubtitle"></div>' +
      '<div id="vnTextbox"><div id="vnName"></div><div id="vnText"></div></div>' +
      '<div id="vnBar">' +
        '<button id="vnLog">ЛОГ</button>' +
        '<button id="vnHide">скрыть текст</button>' +
        '<span class="vnGap"></span>' +
        '<button id="vnAuto">AUTO</button>' +
        '<button id="vnSpeed">1x</button>' +
        '<button id="vnExit">выход</button>' +
      "</div>" +
      '<div id="vnLogPanel" hidden></div>';
    document.body.appendChild(root);

    var btn = document.createElement("button");
    btn.id = "vnEnter";
    btn.textContent = "Режим новеллы";
    document.body.appendChild(btn);

    el.root = root;
    el.bgA = root.querySelector("#vnBgA");
    el.bgB = root.querySelector("#vnBgB");
    el.bgActive = el.bgA;
    el.slots = {
      left: root.querySelector(".vnSlot.left"),
      center: root.querySelector(".vnSlot.center"),
      right: root.querySelector(".vnSlot.right"),
    };
    el.subtitle = root.querySelector("#vnSubtitle");
    el.textbox = root.querySelector("#vnTextbox");
    el.name = root.querySelector("#vnName");
    el.text = root.querySelector("#vnText");
    el.logPanel = root.querySelector("#vnLogPanel");

    btn.addEventListener("click", enterVN);
    root.querySelector("#vnExit").addEventListener("click", exitVN);
    root.querySelector("#vnAuto").addEventListener("click", toggleAuto);
    root.querySelector("#vnSpeed").addEventListener("click", cycleSpeed);
    root.querySelector("#vnHide").addEventListener("click", function (e) { e.stopPropagation(); toggleHide(); });
    root.querySelector("#vnLog").addEventListener("click", function (e) { e.stopPropagation(); toggleLog(); });

    root.addEventListener("click", function (e) {
      if (e.target.closest("#vnBar") || e.target.closest("#vnLogPanel")) return;
      if (uiHidden) { toggleHide(); return; } // первый клик при скрытом UI — вернуть текст
      advance();
    });

    document.addEventListener("keydown", function (e) {
      if (el.root.hidden) return;
      if (e.key === "Escape") { exitVN(); }
      else if (e.key === "ArrowLeft") { back(); }
      else if (e.key === " " || e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); advance(); }
    });
  }

  // ---------- вход / выход ----------
  function enterVN() {
    var enterBtn = document.getElementById("vnEnter");
    enterBtn.disabled = true;
    enterBtn.textContent = "Загрузка...";
    currentStoryTxtKey()
      .then(fetchStoryTxt)
      .then(function (txt) {
        frames = parse(txt);
        if (!frames.length) throw new Error("В этой истории не нашлось реплик");
        pos = 0; maxReached = -1; displayedBg = null;
        return Promise.all([
          getSoundMap(),
          preloadAssets(function (d, t) {
            enterBtn.textContent = "Загрузка " + d + "/" + t;
          }),
        ]);
      })
      .then(function () {
        el.root.hidden = false;
        document.body.classList.add("vn-on");
        render(0, true);
      })
      .catch(function (err) {
        alert("VN-режим: " + err.message);
      })
      .then(function () {
        enterBtn.disabled = false;
        enterBtn.textContent = "Режим новеллы";
      });
  }
  function exitVN() {
    el.root.hidden = true;
    document.body.classList.remove("vn-on");
    stopAuto();
    if (music) { try { music.pause(); } catch (e) {} music = null; }
  }

  // ---------- рендер кадра ----------
  function render(i, forward) {
    if (i < 0) i = 0;
    if (i >= frames.length) { stopAuto(); return; }
    pos = i;
    var f = frames[i];

    // фон: меняем кроссфейдом только если он реально другой (иначе моргает)
    if (f.bg && f.bg !== displayedBg) {
      displayedBg = f.bg;
      var url = assetCache["bg:" + f.bg] || bgUrls(f.bg)[0];
      var next = el.bgActive === el.bgA ? el.bgB : el.bgA;
      next.style.backgroundImage = 'url("' + url + '")';
      next.classList.add("show");
      el.bgActive.classList.remove("show");
      el.bgActive = next;
    }

    // спрайты
    ["left", "center", "right"].forEach(function (slot) {
      var box = el.slots[slot];
      var sp = f.sprites[slot];
      if (!sp) { box.innerHTML = ""; box.classList.remove("dim"); return; }
      var existing = box.querySelector("img");
      var needSrc = sp.name;
      if (!existing || box.dataset.name !== needSrc) {
        box.innerHTML = "";
        var im = document.createElement("img");
        var cached = assetCache["sp:" + sp.name];
        if (cached) im.src = cached;
        else setImgWithFallback(im, spriteUrls(sp.name));
        box.appendChild(im);
        box.dataset.name = needSrc;
      }
      box.classList.toggle("dim", !!sp.dim);
    });

    // звук/музыка только при движении вперёд в новый кадр
    if (forward && i > maxReached) {
      maxReached = i;
      (f.sounds || []).forEach(function (key) { playSfx(key); });
      if (f.music === "stop") { if (music) { try { music.pause(); } catch (e) {} music = null; } }
      else if (f.music && f.music.key) { playMusic(f.music.key, f.music.volume); }
    }

    // текст / субтитр
    if (f.subtitle != null) {
      el.textbox.classList.remove("show");
      el.subtitle.innerHTML = formatText(f.subtitle);
      el.subtitle.classList.add("show");
      logPush("", f.subtitle);
    } else {
      el.subtitle.classList.remove("show");
      el.textbox.classList.add("show");
      el.name.textContent = f.name || "";
      el.name.style.display = f.name ? "" : "none";
      startType(f.text || "");
      logPush(f.name || "", f.text || "");
    }
  }

  // ---------- печатная машинка ----------
  // конвертация форматирования: <color=#xxx>..</color> -> span; <i>,<b> проходят как есть
  function formatText(s) {
    return String(s).replace(
      /<color=([#\w]+)>([\s\S]*?)<\/color>/gi,
      '<span style="color:$1">$2</span>'
    );
  }
  // разбиваем на единицы: тег целиком ИЛИ один видимый символ
  function tokenize(html) {
    var units = [], re = /(<[^>]+>)|([\s\S])/g, m;
    while ((m = re.exec(html))) units.push({ tag: !!m[1], s: m[1] || m[2] });
    return units;
  }
  function startType(full) {
    stopType();
    typedFullHtml = formatText(full);
    var units = tokenize(typedFullHtml);
    var idxU = 0;
    el.text.innerHTML = "";
    var cps = TYPE_CPS * SPEEDS[speedIdx];
    var perTick = Math.max(1, Math.round(cps / 60));
    typing = setInterval(function () {
      var added = 0;
      while (idxU < units.length) {
        if (units[idxU].tag) { idxU++; continue; } // теги вставляются мгновенно, не рвём
        if (added >= perTick) break;
        idxU++; added++;
      }
      var html = "";
      for (var k = 0; k < idxU; k++) html += units[k].s;
      el.text.innerHTML = html;
      if (idxU >= units.length) { stopType(); if (auto) scheduleAuto(); }
    }, Math.max(8, 1000 / cps));
  }
  function stopType() { if (typing) { clearInterval(typing); typing = null; } }
  function finishType() { stopType(); el.text.innerHTML = typedFullHtml; }
  function isTyping() { return !!typing; }

  // ---------- навигация ----------
  function advance() {
    if (el.subtitle.classList.contains("show")) { render(pos + 1, true); return; }
    if (isTyping()) { finishType(); if (auto) scheduleAuto(); return; }
    render(pos + 1, true);
  }
  function back() { stopType(); render(pos - 1, false); }

  // ---------- авто ----------
  function toggleAuto() {
    auto = !auto;
    document.getElementById("vnAuto").classList.toggle("on", auto);
    if (auto) { if (!isTyping()) scheduleAuto(); } else stopAuto();
  }
  function scheduleAuto() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () { if (auto) render(pos + 1, true); }, AUTO_DELAY / SPEEDS[speedIdx]);
  }
  function stopAuto() { clearTimeout(autoTimer); }
  function cycleSpeed() {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    document.getElementById("vnSpeed").textContent = SPEEDS[speedIdx] + "x";
  }

  // ---------- скрытие UI ----------
  function toggleHide() {
    uiHidden = !uiHidden;
    el.root.classList.toggle("vn-ui-hidden", uiHidden);
    document.getElementById("vnHide").classList.toggle("on", uiHidden);
  }

  // ---------- лог ----------
  var logData = [];
  function logPush(name, text) {
    if (pos <= maxReached && logData.length && logData[logData.length - 1].pos === pos) return;
    logData.push({ pos: pos, name: name, text: text });
  }
  function toggleLog() {
    var p = el.logPanel;
    if (!p.hidden) { p.hidden = true; return; }
    p.innerHTML = logData
      .map(function (l) {
        return '<div class="vnLogRow">' + (l.name ? "<b>" + escapeHtml(l.name) + "</b> " : "") + formatText(l.text) + "</div>";
      })
      .join("");
    p.hidden = false;
    p.scrollTop = p.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------- аудио ----------
  function playSfx(key) {
    var urls = soundUrls(key);
    if (!urls.length) return;
    try {
      var a = new Audio(urls[0]);
      a.volume = 0.85;
      a.onerror = function () { if (urls[1]) { a.src = urls[1]; a.play().catch(function () {}); } };
      a.play().catch(function () {});
    } catch (e) {}
  }
  function playMusic(key, vol) {
    var urls = soundUrls(key);
    if (!urls.length) return;
    try {
      if (music) { music.pause(); }
      music = new Audio(urls[0]);
      music.loop = true;
      music.volume = typeof vol === "number" && !isNaN(vol) ? vol : 0.6;
      var m = music;
      m.onerror = function () { if (urls[1]) { m.src = urls[1]; m.play().catch(function () {}); } };
      m.play().catch(function () {});
    } catch (e) {}
  }

  // ---------- стили ----------
  var VN_CSS =
    '#vnEnter{position:fixed;top:8px;left:120px;z-index:9998;background:rgba(20,26,36,.7);color:#dfe6f2;' +
    'border:1px solid rgba(185,205,235,.3);border-radius:.5em;padding:.35em .8em;font:600 14px Manrope,system-ui,sans-serif;' +
    'cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}' +
    '#vnEnter:hover{background:rgba(42,54,74,.8)}' +
    '#vnRoot{position:fixed;inset:0;z-index:9999;background:#06070a;overflow:hidden;' +
    'font-family:Manrope,system-ui,"Segoe UI",sans-serif;color:#eef2f8;user-select:none}' +
    '.vnBg{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity .5s ease}' +
    '.vnBg.show{opacity:1}' +
    '#vnSprites{position:absolute;inset:0;pointer-events:none}' +
    '.vnSlot{position:absolute;bottom:0;height:92%;display:flex;align-items:flex-end;justify-content:center;' +
    'transition:filter .3s ease,opacity .3s ease}' +
    '.vnSlot img{height:100%;width:auto;object-fit:contain;filter:drop-shadow(0 0 30px rgba(0,0,0,.5))}' +
    '.vnSlot.left{left:2%;}.vnSlot.center{left:50%;transform:translateX(-50%);}.vnSlot.right{right:2%;}' +
    '.vnSlot.dim{filter:brightness(.5) saturate(.8);opacity:.85}' +
    '#vnSubtitle{position:absolute;top:42%;left:50%;transform:translateX(-50%);max-width:70%;text-align:center;' +
    'font-size:26px;text-shadow:0 2px 12px #000;opacity:0;transition:opacity .3s}' +
    '#vnSubtitle.show{opacity:1}' +
    '#vnTextbox{position:absolute;left:50%;transform:translateX(-50%);bottom:5%;width:min(900px,82%);' +
    'background:rgba(10,13,20,.62);-webkit-backdrop-filter:blur(14px) saturate(125%);backdrop-filter:blur(14px) saturate(125%);' +
    'border:1px solid rgba(185,205,235,.16);border-radius:14px;padding:18px 26px 22px;box-shadow:0 10px 40px rgba(0,0,0,.5);' +
    'opacity:0;transition:opacity .25s}' +
    '#vnTextbox.show{opacity:1}' +
    '#vnName{font-weight:700;letter-spacing:.03em;color:#9fc0e6;margin-bottom:8px;font-size:18px}' +
    '#vnText{font-size:21px;line-height:1.5;min-height:1.5em}' +
    '#vnBar{position:absolute;top:14px;right:18px;display:flex;gap:8px;align-items:center;z-index:5}' +
    '#vnBar button{background:rgba(20,26,36,.55);color:#dfe6f2;border:1px solid rgba(185,205,235,.22);' +
    'border-radius:.5em;padding:.3em .7em;font:600 13px Manrope,system-ui,sans-serif;cursor:pointer;' +
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}' +
    '#vnBar button:hover{background:rgba(42,54,74,.7)}' +
    '#vnBar button.on{background:rgba(120,140,175,.75);color:#fff}' +
    '#vnBar .vnGap{width:22px}' +
    '#vnRoot.vn-ui-hidden #vnTextbox,#vnRoot.vn-ui-hidden #vnSubtitle,#vnRoot.vn-ui-hidden #vnBar{opacity:0;pointer-events:none}' +
    '#vnLogPanel{position:absolute;inset:8% 12%;background:rgba(8,10,16,.92);border:1px solid rgba(185,205,235,.2);' +
    'border-radius:14px;padding:24px 28px;overflow-y:auto;z-index:6;font-size:17px;line-height:1.6}' +
    '.vnLogRow{margin-bottom:12px}.vnLogRow b{color:#9fc0e6}';

  // ---------- старт ----------
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUI);
  else buildUI();
})();
