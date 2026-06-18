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

  // --- позиционирование спрайтов (можно крутить) ---
  var SLOT_X = { left: 30, center: 50, right: 70 }; // базовый X слота, % ширины кадра
  var REF_W = 1920, REF_H = 1080; // опорное разрешение для пиксельных сдвигов posto
  var REF_CANVAS_H = 1024; // эталонный размер холста (даёт высоту BASE_H)
  var BASE_H = 114;   // базовая высота для эталонного холста, % высоты кадра
  var CANVAS_INFLUENCE = 1; // 1 = рост строго по размеру холста (=росту персонажа в игре)
  var SIZE_MIN = 0.45, SIZE_MAX = 1.25; // пол и потолок: мелкие не исчезают, крупные не теряют голову
  var BASE_BOTTOM = -42; // насколько низ холста уходит за нижний край, %
  var spriteNatH = {}; // родная высота холста спрайта в пикселях (из предзагрузки)

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
  var shakeRAF = null; // кадр анимации тряски
  var soundMap = {}; // ключ звука -> путь к файлу (из story_variables.json)
  var assetCache = {}; // "sp:name"/"bg:name" -> рабочий URL (после предзагрузки)
  var displayedBg = null; // имя сейчас показанного фона (чтобы не моргал)

  // ---------- утилиты URL (с запасными источниками) ----------
  function cgItemUrls(image) {
    var enc = encodeURIComponent(image);
    return [
      "https://raw.githubusercontent.com/akgcc/arkdata/main/assets/torappu/dynamicassets/avg/items/" + enc.toLowerCase() + ".png",
      "https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/avg/items/" + enc + ".png",
    ];
  }
  function spriteUrls(name) {
    // разбор id#face$body и запасные имена, как в самом ридере
    var m = /^(.*?)(?:#(\d+))?(?:\$(\d+))?$/.exec(name) || [];
    var id = m[1] || name;
    var face = ((m[2] || "1").replace(/^0+/, "")) || "1";
    var body = ((m[3] || "1").replace(/^0+/, "")) || "1";
    var full = id + "#" + face + "$" + body;
    var variants = [name, full, id + "#" + face, id + "$" + body, id + "#1$1", id];
    // Aceship на jsdelivr — операторы; akgcc через raw.githubusercontent — NPC и остальное
    // (jsdelivr не отдаёт файлы из огромного репозитория akgcc, поэтому для него только raw)
    var ACE = "https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/avg/characters/";
    var AKG_RAW = "https://raw.githubusercontent.com/akgcc/arkdata/main/assets/avg/characters/";
    var seen = {}, out = [];
    variants.forEach(function (v) {
      if (!v || seen[v]) return;
      seen[v] = 1;
      var enc = encodeURIComponent(v);
      out.push(ACE + enc + ".png"); // операторы (быстрый CDN)
      out.push(AKG_RAW + enc.toLowerCase() + ".png"); // NPC и всё остальное
    });
    out.push("https://raw.githubusercontent.com/akgcc/arkdata/main/thumbs/" + encodeURIComponent(full).toLowerCase() + ".webp");
    return out;
  }
  function bgUrls(image) {
    var enc = encodeURIComponent(image);
    var lc = enc.toLowerCase();
    return [
      "https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/avg/backgrounds/" + enc + ".png",
      "https://raw.githubusercontent.com/akgcc/arkdata/main/assets/torappu/dynamicassets/avg/backgrounds/" + lc + ".png",
    ];
  }
  function cgUrls(image) {
    var enc = encodeURIComponent(image);
    var lc = enc.toLowerCase();
    return [
      "https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/avg/images/" + enc + ".png",
      "https://raw.githubusercontent.com/akgcc/arkdata/main/assets/torappu/dynamicassets/avg/images/" + lc + ".png",
    ];
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
    var cg = null; // CG-иллюстрация во весь экран: {image,x,y,scale} | null
    var grayscale = 0; // текущее обесцвечивание сцены (CameraEffect)
    var filterFade = 0; // длительность перехода фильтра
    var blocker = { a: 0, r: 0, g: 0, b: 0 }; // заливка покоя (Blocker)
    var curtain = 0, curtainFade = 0; // доля чёрных полос сверху/снизу
    var focusBg = 0, focusChar = 0, focusFade = 0; // расфокус фона/персонажей
    var bgTf = { x: 0, y: 0, s: 1 }; // трансформация фона покоя (BackgroundTween)
    var grid = null; // панорама gridbg: {imgs,w,h,x,y,fade} | null
    var largeY = 0; // вертикальная позиция largebgtween (игровые единицы)
    var pendingLargeTween = null; // {yFrom,yTo,dur} вертикальный проезд
    var cgItems = {}; // активные слои cgitem по имени картинки
    var pendingBgTween = null; // анимация проезда фона
    var pendingSticker = null; // текстовый стикер на кадр
    var pendingShake = null; // тряска на следующий кадр
    var pendingBlockerAnim = null; // анимация заливки (вспышка/затемнение)
    var pendingSounds = [];
    var pendingMusic = null; // {key,volume} | 'stop' | null
    var pendingName = null;

    function pushFrame(extra) {
      function snapSlot(slot) {
        var s = cur[slot];
        if (!s) return null;
        return { name: s.name, scale: s.scale, x: s.x, y: s.y, alpha: s.alpha, shadow: s.shadow || 0,
                 dim: !!(focusSlot && focusSlot !== slot) };
      }
      var snap = { left: snapSlot("left"), center: snapSlot("center"), right: snapSlot("right") };
      var f = {
        bg: bg,
        cg: cg,
        sprites: snap,
        grayscale: grayscale,
        filterFade: filterFade,
        blocker: { a: blocker.a, r: blocker.r, g: blocker.g, b: blocker.b },
        blockerAnim: pendingBlockerAnim,
        shake: pendingShake,
        curtain: curtain,
        curtainFade: curtainFade,
        focusBg: focusBg,
        focusChar: focusChar,
        focusFade: focusFade,
        bgTf: { x: bgTf.x, y: bgTf.y, s: bgTf.s },
        grid: grid ? { imgs: grid.imgs.slice(), w: grid.w, h: grid.h, x: grid.x, y: grid.y, fade: grid.fade } : null,
        largeY: largeY,
        largeTween: pendingLargeTween,
        cgItems: Object.keys(cgItems).map(function (k) {
          var c = cgItems[k]; var o = {}; for (var p in c) o[p] = c[p]; return o;
        }),
        bgTween: pendingBgTween,
        sticker: pendingSticker,
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
      pendingBlockerAnim = null;
      pendingShake = null;
      pendingBgTween = null;
      pendingLargeTween = null;
      pendingSticker = null;
      filterFade = 0;
      curtainFade = 0;
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
          if (paren < 0 || (!args.name && !args.slot && !args.focus && args.scale === undefined && args.posto === undefined)) {
            // пустой [charslot] -> очистить всех
            cur = { left: null, center: null, right: null };
            focusSlot = null;
            continue;
          }
          var slot = SLOT[(args.slot || "").toLowerCase()] || "center";
          if (args.name) {
            // защита от дублей: убираем того же персонажа из других слотов (он переехал, а не размножился)
            var bn = args.name.split("#")[0].split("$")[0];
            ["left", "center", "right"].forEach(function (sl) {
              if (sl !== slot && cur[sl] && cur[sl].name &&
                  cur[sl].name.split("#")[0].split("$")[0] === bn) cur[sl] = null;
            });
            if (!cur[slot]) cur[slot] = { name: args.name, scale: 1, x: 0, y: 0, alpha: 1 };
            else cur[slot].name = args.name;
            // показ/смена персонажа: по умолчанию снова видим (сбрасываем залипшую прозрачность от ушедшего ato=0),
            // если только команда явно не задаёт конечную прозрачность через ato
            if (args.ato === undefined) cur[slot].alpha = 1;
          }
          if (cur[slot]) {
            if (args.scale !== undefined) cur[slot].scale = parseFloat(args.scale) || 1;
            // posto применяем как позицию покоя, но НЕ на транзиентных анимациях
            // (action="jump"/"shake" и т.п. — это подскок, а не новое место)
            if (args.posto !== undefined && args.action === undefined) {
              var pp = String(args.posto).split(",");
              cur[slot].x = parseFloat(pp[0]) || 0;
              cur[slot].y = parseFloat(pp[1]) || 0;
            }
            if (args.ato !== undefined) cur[slot].alpha = parseFloat(args.ato);
            // тень-силуэт: градиентное затемнение спрайта (скрывает лицо у загадочных фигур)
            var blk = args.blackend != null ? args.blackend
              : args.bend != null ? args.bend
              : args.blackend2 != null ? args.blackend2
              : args.black != null ? args.black : undefined;
            if (blk !== undefined) cur[slot].shadow = (String(blk) === "true") ? 1 : (parseFloat(blk) || 0);
            else if (args.name) cur[slot].shadow = 0; // обычный показ персонажа -> без тени
          }
          if (args.focus !== undefined) {
            var fv = String(args.focus).toLowerCase();
            // none -> фокуса нет; all -> подсвечены все. И то, и другое = никого не затемняем
            if (fv === "none" || fv === "n" || fv === "-1" || fv === "all" || fv === "a") focusSlot = null;
            else focusSlot = SLOT[fv] || slot;
          }
        } else if (cmd === "background") {
          if (args.image) { bg = args.image; bgTf = { x: 0, y: 0, s: 1 }; grid = null; largeY = 0; cgItems = {}; }
        } else if (cmd === "cgitem") {
          if (args.image) {
            var pf = String(args.pfrom || "0,0").split(","), pt = String(args.pto || args.pfrom || "0,0").split(",");
            cgItems[args.image] = {
              image: args.image,
              sfrom: args.sfrom != null ? parseFloat(args.sfrom) : 1,
              sto: args.sto != null ? parseFloat(args.sto) : (args.sfrom != null ? parseFloat(args.sfrom) : 1),
              sdur: parseFloat(args.sduration || "0") || 0,
              afrom: args.afrom != null ? parseFloat(args.afrom) : 1,
              ato: args.ato != null ? parseFloat(args.ato) : 1,
              adur: parseFloat(args.aduration || "0") || 0,
              pfx: parseFloat(pf[0]) || 0, pfy: parseFloat(pf[1]) || 0,
              ptx: parseFloat(pt[0]) || 0, pty: parseFloat(pt[1]) || 0,
              pdur: parseFloat(args.pduration || "0") || 0,
              layer: parseInt(args.layer || "1", 10) || 1,
            };
          }
        } else if (cmd === "hidecgitem") {
          if (args.image) delete cgItems[args.image];
          else cgItems = {};
        } else if (cmd === "gridbg") {
          if (!args.imagegroup) {
            grid = null; largeY = 0; // пустой [gridbg] -> убрать панораму
          } else {
            var ws = String(args.solidwidth || "").split("/");
            var hs = String(args.solidheight || "").split("/");
            grid = {
              imgs: String(args.imagegroup).split("/"),
              w: parseFloat(ws[0]) || 1280,
              h: parseFloat(hs[0]) || 720,
              x: parseFloat(args.x || "0") || 0,
              y: parseFloat(args.y || "0") || 0,
              fade: parseFloat(args.fadetime || "0") || 0,
            };
          }
        } else if (cmd === "largebgtween") {
          var lyf = args.yfrom != null ? parseFloat(args.yfrom) : largeY;
          var lyt = args.yto != null ? parseFloat(args.yto) : largeY;
          pendingLargeTween = { yFrom: lyf, yTo: lyt, dur: parseFloat(args.duration || "0") || 0 };
          largeY = lyt;
        } else if (cmd === "image") {
          // CG-иллюстрация во весь экран; [Image] без image -> убрать
          if (args.image)
            cg = {
              image: args.image,
              x: parseFloat(args.x || "0") || 0,
              y: parseFloat(args.y || "0") || 0,
              scale: parseFloat(args.xscale || args.scale || "1") || 1,
            };
          else cg = null;
        } else if (cmd === "camerashake") {
          var xs = parseFloat(args.xstrength || "0"), ys = parseFloat(args.ystrength || "0");
          if (xs || ys)
            pendingShake = { x: xs, y: ys, dur: parseFloat(args.duration || "0"), vib: parseFloat(args.vibrato || "10") };
        } else if (cmd === "cameraeffect") {
          if ((args.effect || "").toLowerCase() === "grayscale") {
            grayscale = parseFloat(args.amount != null ? args.amount : "0") || 0;
            filterFade = parseFloat(args.fadetime || "0") || 0;
          }
        } else if (cmd === "blocker") {
          var ba = parseFloat(args.a || "0") || 0, br = parseFloat(args.r || "0") || 0,
              bg2 = parseFloat(args.g || "0") || 0, bb = parseFloat(args.b || "0") || 0;
          var fa = args.afrom != null ? parseFloat(args.afrom) : ba;
          var frr = args.rfrom != null ? parseFloat(args.rfrom) : br;
          var fg = args.gfrom != null ? parseFloat(args.gfrom) : bg2;
          var fb = args.bfrom != null ? parseFloat(args.bfrom) : bb;
          blocker = { a: ba, r: br, g: bg2, b: bb };
          pendingBlockerAnim = {
            fromA: fa, fromR: frr, fromG: fg, fromB: fb,
            toA: ba, toR: br, toG: bg2, toB: bb,
            fade: parseFloat(args.fadetime || "0") || 0,
          };
        } else if (cmd === "curtain") {
          var cf = args.fillto != null ? parseFloat(args.fillto) : (args.fill != null ? parseFloat(args.fill) : 0);
          curtain = isNaN(cf) ? 0 : cf;
          curtainFade = parseFloat(args.fadetime || "0") || 0;
        } else if (cmd === "focusout") {
          var ft = (args.type || "").toLowerCase();
          var amt = parseFloat(args.to != null ? args.to : "0") || 0;
          if (ft === "bg") focusBg = amt;
          else if (ft === "char") focusChar = amt;
          focusFade = parseFloat(args.duration || "0") || 0;
        } else if (cmd === "backgroundtween") {
          var txTo = args.xto != null ? parseFloat(args.xto) : bgTf.x;
          var tyTo = args.yto != null ? parseFloat(args.yto) : bgTf.y;
          var tsTo = args.xscaleto != null ? parseFloat(args.xscaleto) : bgTf.s;
          pendingBgTween = {
            fromX: args.xfrom != null ? parseFloat(args.xfrom) : bgTf.x,
            fromY: args.yfrom != null ? parseFloat(args.yfrom) : bgTf.y,
            fromS: bgTf.s,
            toX: txTo, toY: tyTo, toS: tsTo,
            dur: parseFloat(args.duration || "0") || 0,
          };
          bgTf = { x: txTo, y: tyTo, s: tsTo };
        } else if (cmd === "sticker") {
          if (args.text)
            pendingSticker = {
              text: args.text,
              x: parseFloat(args.x || "0") || 0,
              y: parseFloat(args.y || "0") || 0,
              size: parseFloat(args.size || "24") || 24,
            };
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
      im.onload = function () { resolve({ url: im.src, h: im.naturalHeight }); };
      im.onerror = function () { i++; if (i < urls.length) im.src = urls[i]; else resolve({ url: null, h: 0 }); };
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
      if (f.cg && f.cg.image && !seen["cg:" + f.cg.image]) { seen["cg:" + f.cg.image] = 1; jobs.push({ key: "cg:" + f.cg.image, urls: cgUrls(f.cg.image) }); }
      if (f.grid) f.grid.imgs.forEach(function (nm) {
        if (!seen["bg:" + nm]) { seen["bg:" + nm] = 1; jobs.push({ key: "bg:" + nm, urls: bgUrls(nm) }); }
      });
      if (f.cgItems) f.cgItems.forEach(function (it) {
        if (!seen["cgi:" + it.image]) { seen["cgi:" + it.image] = 1; jobs.push({ key: "cgi:" + it.image, urls: cgItemUrls(it.image) }); }
      });
      ["left", "center", "right"].forEach(function (s) {
        var sp = f.sprites[s];
        if (sp && !seen["sp:" + sp.name]) { seen["sp:" + sp.name] = 1; jobs.push({ key: "sp:" + sp.name, urls: spriteUrls(sp.name) }); }
      });
    });
    var done = 0, total = jobs.length;
    if (!total) return Promise.resolve();
    return Promise.all(
      jobs.map(function (j) {
        return loadFirst(j.urls).then(function (res) {
          assetCache[j.key] = res.url || null; // не кэшируем битый адрес: рендер сам переберёт запасные
          if (j.key.indexOf("sp:") === 0 && res.h) spriteNatH[j.key.slice(3)] = res.h;
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
      '<div id="vnStage">' +
        '<div id="vnScene">' +
          '<div id="vnBgWrap"><div id="vnBgA" class="vnBg"></div><div id="vnBgB" class="vnBg"></div></div>' +
          '<div id="vnGrid"></div>' +
          '<div id="vnSprites"><div class="vnSlot left"></div><div class="vnSlot center"></div><div class="vnSlot right"></div></div>' +
          '<div id="vnCG"></div>' +
          '<div id="vnCgItems"></div>' +
        "</div>" +
        '<div id="vnBlocker"></div>' +
        '<div id="vnCurtainTop" class="vnCurtain"></div>' +
        '<div id="vnCurtainBottom" class="vnCurtain"></div>' +
        '<div id="vnSticker"></div>' +
        '<div id="vnSubtitle"></div>' +
        '<div id="vnTextbox"><div id="vnLine"><div id="vnName"></div><div id="vnText"></div></div></div>' +
        '<div id="vnBarL">' +
          '<button id="vnLog">ЛОГ</button>' +
          '<button id="vnHide">скрыть</button>' +
        "</div>" +
        '<div id="vnBarR">' +
          '<button id="vnAuto">AUTO</button>' +
          '<button id="vnSpeed">1x</button>' +
          '<button id="vnExit">выход</button>' +
        "</div>" +
        '<div id="vnLogPanel" hidden></div>' +
      "</div>";
    document.body.appendChild(root);

    var btn = document.createElement("button");
    btn.id = "vnEnter";
    btn.textContent = "Режим новеллы";
    document.body.appendChild(btn);

    el.root = root;
    el.bgA = root.querySelector("#vnBgA");
    el.bgB = root.querySelector("#vnBgB");
    el.bgActive = el.bgA;
    el.scene = root.querySelector("#vnScene");
    el.blocker = root.querySelector("#vnBlocker");
    el.sprites = root.querySelector("#vnSprites");
    el.bgWrap = root.querySelector("#vnBgWrap");
    el.grid = root.querySelector("#vnGrid");
    el.curtainTop = root.querySelector("#vnCurtainTop");
    el.curtainBottom = root.querySelector("#vnCurtainBottom");
    el.sticker = root.querySelector("#vnSticker");
    el.slots = {
      left: root.querySelector(".vnSlot.left"),
      center: root.querySelector(".vnSlot.center"),
      right: root.querySelector(".vnSlot.right"),
    };
    el.subtitle = root.querySelector("#vnSubtitle");
    el.cg = root.querySelector("#vnCG");
    el.cgItems = root.querySelector("#vnCgItems");
    el.textbox = root.querySelector("#vnTextbox");
    el.name = root.querySelector("#vnName");
    el.line = root.querySelector("#vnLine");
    el.text = root.querySelector("#vnText");
    el.logPanel = root.querySelector("#vnLogPanel");

    btn.addEventListener("click", enterVN);
    root.querySelector("#vnExit").addEventListener("click", exitVN);
    root.querySelector("#vnAuto").addEventListener("click", toggleAuto);
    root.querySelector("#vnSpeed").addEventListener("click", cycleSpeed);
    root.querySelector("#vnHide").addEventListener("click", function (e) { e.stopPropagation(); toggleHide(); });
    root.querySelector("#vnLog").addEventListener("click", function (e) { e.stopPropagation(); toggleLog(); });

    root.addEventListener("click", function (e) {
      if (e.target.closest("#vnBarL") || e.target.closest("#vnBarR") || e.target.closest("#vnLogPanel")) return;
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
    if (shakeRAF) { cancelAnimationFrame(shakeRAF); shakeRAF = null; }
    if (el.scene) { el.scene.style.transform = ""; el.scene.style.filter = "none"; }
    if (music) { try { music.pause(); } catch (e) {} music = null; }
  }

  // ---------- рендер кадра ----------
  function render(i, forward) {
    if (i < 0) i = 0;
    if (i >= frames.length) { stopAuto(); return; }
    pos = i;
    var f = frames[i];
    var isNew = forward && i > maxReached; // вперёд в ещё не виденный кадр

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

    // спрайты: позиция = базовый X слота + posto, высота = база * scale, низ за кадром + posto.y
    ["left", "center", "right"].forEach(function (slot) {
      var box = el.slots[slot];
      var sp = f.sprites[slot];
      if (!sp) { box.innerHTML = ""; box.dataset.name = ""; return; }
      var img = box.querySelector("img");
      if (!img || box.dataset.name !== sp.name) {
        box.innerHTML = "";
        img = document.createElement("img");
        var cached = assetCache["sp:" + sp.name];
        var urls = spriteUrls(sp.name);
        if (cached && urls[0] !== cached) urls = [cached].concat(urls); // кэш как подсказка, но с полным запасом
        var spName = sp.name, spScale = sp.scale || 1;
        img.onload = function () {
          if (!this.naturalHeight) return;
          spriteNatH[spName] = this.naturalHeight; // уточняем реальную высоту холста
          var sf = Math.min(SIZE_MAX, Math.max(SIZE_MIN, 1 + CANVAS_INFLUENCE * (this.naturalHeight / REF_CANVAS_H - 1)));
          this.style.height = BASE_H * sf * spScale + "%";
          var shEl = this.parentElement && this.parentElement.querySelector(".vnShadow");
          if (shEl) { var u = 'url("' + (this.currentSrc || this.src) + '")'; shEl.style.webkitMaskImage = u; shEl.style.maskImage = u; shEl.dataset.mask = this.currentSrc || this.src; }
        };
        setImgWithFallback(img, urls);
        box.appendChild(img);
        var shadow = document.createElement("div");
        shadow.className = "vnShadow";
        box.appendChild(shadow);
        box.dataset.name = sp.name;
      }
      var xPct = SLOT_X[slot] + (sp.x / REF_W) * 100;
      var natH = spriteNatH[sp.name] || REF_CANVAS_H;
      var sizeFactor = 1 + CANVAS_INFLUENCE * (natH / REF_CANVAS_H - 1); // мягкое влияние размера холста
      sizeFactor = Math.min(SIZE_MAX, Math.max(SIZE_MIN, sizeFactor)); // с потолком и полом
      var h = BASE_H * sizeFactor * (sp.scale || 1);
      var b = BASE_BOTTOM + (sp.y / REF_H) * 100;
      img.style.left = xPct + "%";
      img.style.height = h + "%";
      img.style.bottom = b + "%";
      img.style.opacity = sp.alpha == null ? 1 : sp.alpha;
      img.style.filter = sp.dim ? "brightness(.5) saturate(.8)" : "none";
      // тень-силуэт: градиент, маскированный формой спрайта (темнее у головы)
      var sh = box.querySelector(".vnShadow");
      if (sh) {
        if (sp.shadow > 0) {
          sh.style.left = xPct + "%";
          sh.style.bottom = b + "%";
          sh.style.height = h + "%";
          sh.style.width = h * (REF_H / REF_W) + "%"; // спрайт квадратный -> ширина = высота в px
          sh.style.opacity = sp.dim ? 0.65 : 1;
          sh.style.background = "linear-gradient(to bottom, rgba(0,0,0," + sp.shadow + ") 0%, rgba(0,0,0," +
            (sp.shadow * 0.92).toFixed(2) + ") 24%, rgba(0,0,0,0) 60%)";
          var ssrc = img.currentSrc || img.src;
          if (ssrc && sh.dataset.mask !== ssrc) {
            var um = 'url("' + ssrc + '")'; sh.style.webkitMaskImage = um; sh.style.maskImage = um; sh.dataset.mask = ssrc;
          }
          sh.style.display = "block";
        } else {
          sh.style.display = "none";
        }
      }
    });

    // CG-иллюстрация во весь экран
    if (f.cg && f.cg.image) {
      var cgurl = assetCache["cg:" + f.cg.image] || cgUrls(f.cg.image)[0];
      el.cg.style.backgroundImage = 'url("' + cgurl + '")';
      el.cg.classList.add("show");
    } else {
      el.cg.classList.remove("show");
    }

    // панорама gridbg (2 столбца, тайлы L1/R1/L2/R2 ...); те же пропорции 16:9, что у сцены
    if (f.grid) {
      var g = f.grid;
      var cols = 2, rows = Math.ceil(g.imgs.length / cols);
      var Z = 1.6; // зум-запас: панорама шире сцены, чтобы был ход для проезда и дрейфа
      // сдвиг translate в % считается от размера #vnGrid (Z*100% сцены), поэтому делим на Z
      var maxStage = (Z - 1) / 2 * 100; // запас краёв в % сцены (~30%)
      var panStage = Math.max(-(maxStage - 6), Math.min(maxStage - 6, (g.x / (cols * g.w / 2)) * 18)); // data-проезд по сцене, %
      var px = panStage / Z, py = (Math.max(-(maxStage - 6), Math.min(maxStage - 6, (g.y / (rows * g.h / 2)) * 18))) / Z;
      var tf = "translate(" + px.toFixed(2) + "%," + py.toFixed(2) + "%)";
      var sig = g.imgs.join("|") + ":" + cols + "x" + rows;
      if (el.grid.dataset.sig !== sig) {
        // новая панорама: пересобираем тайлы внутри дрейфующего слоя
        el.grid.style.width = (Z * 100) + "%";
        el.grid.style.height = (Z * 100) + "%";
        el.grid.style.left = ((100 - Z * 100) / 2) + "%";
        el.grid.style.top = ((100 - Z * 100) / 2) + "%";
        var lift = document.createElement("div");
        lift.id = "vnGridLift";
        lift.style.cssText = "position:absolute;inset:0";
        var inner = document.createElement("div");
        inner.id = "vnGridInner";
        g.imgs.forEach(function (nm, idx) {
          var col = idx % cols, row = Math.floor(idx / cols);
          var t = document.createElement("img");
          t.style.cssText = "position:absolute;left:" + (col * 100 / cols) + "%;top:" + (row * 100 / rows) +
            "%;width:" + (100 / cols) + "%;height:" + (100 / rows) + "%;object-fit:cover";
          var cTile = assetCache["bg:" + nm];
          var us = bgUrls(nm);
          setImgWithFallback(t, cTile && us[0] !== cTile ? [cTile].concat(us) : us);
          inner.appendChild(t);
        });
        lift.appendChild(inner);
        el.grid.innerHTML = "";
        el.grid.appendChild(lift);
        el.gridLift = lift;
        el.grid.dataset.sig = sig;
        el.grid.style.transition = "none";
        el.grid.style.transform = tf;
        void el.grid.offsetWidth; // reflow, чтобы стартовое положение не проезжало
      }
      // largebgtween: медленный вертикальный проезд неба (отдельный слой, чтобы не мешать дрейфу и x-проезду)
      if (el.gridLift) {
        if (isNew && f.largeTween && f.largeTween.dur > 0.1) {
          el.gridLift.getAnimations().forEach(function (a) { a.cancel(); });
          el.gridLift.animate(
            [{ transform: "translateY(" + mapLargeY(f.largeTween.yFrom) + "%)" },
             { transform: "translateY(" + mapLargeY(f.largeTween.yTo) + "%)" }],
            { duration: f.largeTween.dur * 1000, fill: "forwards", easing: "linear" }
          );
        } else if (!f.largeTween) {
          el.gridLift.getAnimations().forEach(function (a) { a.cancel(); });
          el.gridLift.style.transform = "translateY(" + mapLargeY(f.largeY) + "%)";
        }
      }
      // data-проезд по x,y и плавное появление (постоянный дрейф идёт на внутреннем слое)
      el.grid.style.transition = "transform " + g.fade + "s ease, opacity " + g.fade + "s ease";
      el.grid.style.transform = tf;
      el.grid.style.opacity = "1";
    } else {
      el.grid.style.opacity = "0";
    }

    // cgitem: многослойная анимированная CG
    renderCgItems(f.cgItems || [], isNew);

    // фильтр камеры (обесцвечивание) — состояние, ставим всегда
    el.scene.style.transitionDuration = (f.filterFade || 0) + "s";
    el.scene.style.filter = f.grayscale > 0 ? "grayscale(" + f.grayscale + ")" : "none";
    // заливка (Blocker): покой ставим всегда, вспышку/затемнение проигрываем только вперёд
    applyBlocker(f.blocker, isNew ? f.blockerAnim : null);

    // проезд/наезд фона (BackgroundTween) + расфокус фона (focusout type=bg)
    var bgFilter = f.focusBg > 0
      ? "blur(" + (f.focusBg * 6).toFixed(1) + "px) brightness(" + (1 - f.focusBg * 0.45).toFixed(2) + ")"
      : "none";
    if (isNew && f.bgTween && f.bgTween.dur > 0) {
      el.bgWrap.style.transition = "none";
      el.bgWrap.style.transform = bgTransformStr(f.bgTween.fromX, f.bgTween.fromY, f.bgTween.fromS);
      void el.bgWrap.offsetWidth;
      el.bgWrap.style.transition = "transform " + f.bgTween.dur + "s ease,filter " + (f.focusFade || 0) + "s ease";
      el.bgWrap.style.transform = bgTransformStr(f.bgTf.x, f.bgTf.y, f.bgTf.s);
    } else {
      el.bgWrap.style.transition = "transform 0s,filter " + (f.focusFade || 0) + "s ease";
      el.bgWrap.style.transform = bgTransformStr(f.bgTf.x, f.bgTf.y, f.bgTf.s);
    }
    el.bgWrap.style.filter = bgFilter;

    // расфокус персонажей (focusout type=char)
    el.sprites.style.transition = "filter " + (f.focusFade || 0) + "s ease";
    el.sprites.style.filter = f.focusChar > 0
      ? "blur(" + (f.focusChar * 5).toFixed(1) + "px) brightness(" + (1 - f.focusChar * 0.4).toFixed(2) + ")"
      : "none";

    // шторки (curtain): чёрные полосы сверху и снизу
    var ch = (f.curtain || 0) * 100;
    el.curtainTop.style.transition = el.curtainBottom.style.transition = "height " + (f.curtainFade || 0) + "s ease";
    el.curtainTop.style.height = el.curtainBottom.style.height = ch + "%";

    // текстовый стикер
    if (f.sticker && f.sticker.text) {
      el.sticker.innerHTML = formatText(f.sticker.text);
      el.sticker.style.fontSize = Math.round((f.sticker.size || 24) * 1.1) + "px";
      el.sticker.classList.add("show");
    } else {
      el.sticker.classList.remove("show");
    }

    // звук/музыка/тряска только при движении вперёд в новый кадр
    if (isNew) {
      maxReached = i;
      (f.sounds || []).forEach(function (key) { playSfx(key); });
      if (f.music === "stop") { if (music) { try { music.pause(); } catch (e) {} music = null; } }
      else if (f.music && f.music.key) { playMusic(f.music.key, f.music.volume); }
      if (f.shake) shakeStage(f.shake);
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
      el.line.classList.toggle("noname", !f.name);
      startType(f.text || "");
      logPush(f.name || "", f.text || "");
    }
  }

  // ---------- cgitem: слои анимированной CG ----------
  var CG_REF_W = 1280, CG_REF_H = 720;
  function sizeCgImg(im, it) {
    if (!im.naturalWidth) return;
    // размер слоя по натуральному размеру картинки в системе координат 1280x720 (масштаб задаётся трансформом)
    im.style.width = (im.naturalWidth / CG_REF_W * 100) + "%";
    im.style.height = (im.naturalHeight / CG_REF_H * 100) + "%";
  }
  function renderCgItems(list, play) {
    var cont = el.cgItems;
    if (!cont) return;
    var want = {};
    list.forEach(function (it) { want[it.image] = it; });
    // убрать отсутствующие слои с затуханием
    Array.prototype.slice.call(cont.children).forEach(function (layer) {
      var key = layer.dataset.cg;
      if (key && !want[key]) {
        layer.dataset.cg = "";
        layer.getAnimations().forEach(function (a) { a.cancel(); });
        var im0 = layer.querySelector("img");
        if (im0) im0.getAnimations().forEach(function (a) { a.cancel(); });
        layer.style.transition = "opacity .4s ease";
        layer.style.opacity = "0";
        setTimeout(function () { if (layer.parentElement) layer.parentElement.removeChild(layer); }, 450);
      }
    });
    // добавить/обновить активные
    list.forEach(function (it) {
      var layer = null, kids = cont.children;
      for (var k = 0; k < kids.length; k++) if (kids[k].dataset.cg === it.image) { layer = kids[k]; break; }
      var sig = JSON.stringify(it);
      var fresh = !layer;
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "vnCgLayer";
        layer.dataset.cg = it.image;
        var im = document.createElement("img");
        im.onload = function () { sizeCgImg(this, it); };
        var cc = assetCache["cgi:" + it.image];
        var us = cgItemUrls(it.image);
        setImgWithFallback(im, cc && us[0] !== cc ? [cc].concat(us) : us);
        layer.appendChild(im);
        cont.appendChild(layer);
      } else if (layer.dataset.sig === sig) {
        return; // без изменений — не дёргаем анимацию
      }
      layer.style.zIndex = it.layer || 1;
      layer.dataset.sig = sig;
      applyCgAnim(layer, layer.querySelector("img"), it, play || fresh);
    });
  }
  function applyCgAnim(layer, im, it, play) {
    if (!im) return;
    sizeCgImg(im, it);
    var pfx = it.pfx / CG_REF_W * 100, pfy = it.pfy / CG_REF_H * 100;
    var ptx = it.ptx / CG_REF_W * 100, pty = it.pty / CG_REF_H * 100;
    var base = "translate(-50%,-50%) ";
    layer.getAnimations().forEach(function (a) { a.cancel(); });
    im.getAnimations().forEach(function (a) { a.cancel(); });
    // позиция (на слое)
    if (play && it.pdur > 0 && (pfx !== ptx || pfy !== pty)) {
      layer.animate([{ transform: "translate(" + pfx + "%," + pfy + "%)" },
                     { transform: "translate(" + ptx + "%," + pty + "%)" }],
        { duration: it.pdur * 1000, fill: "forwards", easing: "ease-out" });
    } else layer.style.transform = "translate(" + ptx + "%," + pty + "%)";
    // масштаб (на картинке, вокруг её центра)
    if (play && it.sdur > 0 && it.sfrom !== it.sto) {
      im.animate([{ transform: base + "scale(" + it.sfrom + ")" },
                  { transform: base + "scale(" + it.sto + ")" }],
        { duration: it.sdur * 1000, fill: "forwards", easing: "ease-out" });
    } else im.style.transform = base + "scale(" + it.sto + ")";
    // прозрачность
    if (play && it.adur > 0 && it.afrom !== it.ato) {
      im.animate([{ opacity: it.afrom }, { opacity: it.ato }],
        { duration: it.adur * 1000, fill: "forwards", easing: "linear" });
    } else im.style.opacity = it.ato;
  }

  // ---------- эффекты: заливка и тряска ----------
  function mapLargeY(y) {
    // игровая вертикаль largebgtween (~0..900, центр ~450) -> сдвиг слоя, %
    return Math.max(-6, Math.min(6, ((y - 450) / 900) * 6));
  }
  function bgTransformStr(x, y, s) {
    return "translate(" + (x / REF_W * 100).toFixed(2) + "%," + (y / REF_H * 100).toFixed(2) + "%) scale(" + (s || 1) + ")";
  }
  function rgbaStr(c) {
    return "rgba(" + Math.round((c.r || 0) * 255) + "," + Math.round((c.g || 0) * 255) +
      "," + Math.round((c.b || 0) * 255) + "," + (c.a || 0) + ")";
  }
  function applyBlocker(resting, anim) {
    if (anim && anim.fade > 0 &&
        (anim.fromA !== anim.toA || anim.fromR !== anim.toR || anim.fromG !== anim.toG || anim.fromB !== anim.toB)) {
      // вспышка/переход: мгновенно ставим стартовый цвет, затем плавно к конечному
      el.blocker.style.transition = "none";
      el.blocker.style.backgroundColor = rgbaStr({ a: anim.fromA, r: anim.fromR, g: anim.fromG, b: anim.fromB });
      void el.blocker.offsetWidth; // reflow, чтобы старт применился до перехода
      el.blocker.style.transition = "background-color " + anim.fade + "s linear";
      el.blocker.style.backgroundColor = rgbaStr({ a: anim.toA, r: anim.toR, g: anim.toG, b: anim.toB });
    } else {
      el.blocker.style.transition = "none";
      el.blocker.style.backgroundColor = rgbaStr(resting || { a: 0 });
    }
  }
  function shakeStage(s) {
    if (shakeRAF) cancelAnimationFrame(shakeRAF);
    var ampX = Math.min(35, (s.x || 0) * 6), ampY = Math.min(20, (s.y || 0) * 6);
    var dur = s.dur > 0 ? s.dur * 1000 : (s.dur === -1 ? 700 : 350);
    var freq = s.vib || 10;
    var t0 = performance.now();
    function tick(now) {
      var e = now - t0;
      if (e >= dur) { el.scene.style.transform = ""; shakeRAF = null; return; }
      var decay = 1 - e / dur;
      var ph = (e / 1000) * freq;
      var dx = Math.sin(ph * 6.28) * ampX * decay * (0.6 + Math.random() * 0.4);
      var dy = Math.cos(ph * 7.0) * ampY * decay * (0.6 + Math.random() * 0.4);
      // лёгкий зум, чтобы тряска не открывала чёрные края
      el.scene.style.transform = "scale(1.05) translate(" + dx.toFixed(1) + "px," + dy.toFixed(1) + "px)";
      shakeRAF = requestAnimationFrame(tick);
    }
    shakeRAF = requestAnimationFrame(tick);
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
    "@import url('https://fonts.googleapis.com/css2?family=Fira+Sans+Condensed:wght@400;500;600;700&display=swap');" +
    '#vnEnter{position:fixed;top:8px;left:120px;z-index:9998;background:rgba(20,26,36,.7);color:#dfe6f2;' +
    'border:1px solid rgba(185,205,235,.3);border-radius:.5em;padding:.35em .8em;font:600 14px Manrope,system-ui,sans-serif;' +
    'cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}' +
    '#vnEnter:hover{background:rgba(42,54,74,.8)}' +
    /* затемнённый фон вокруг окна */
    '#vnRoot{position:fixed;inset:0;z-index:9999;background:#05060a;display:flex;align-items:center;justify-content:center;' +
    'font-family:"Fira Sans Condensed",Manrope,system-ui,"Segoe UI",sans-serif;color:#eef2f8;user-select:none}' +
    '#vnRoot[hidden]{display:none}' +
    /* окно формата телефона 16:9 (max-width можно крутить) */
    '#vnStage{position:relative;aspect-ratio:16/9;width:min(96vw,calc(94vh*16/9));max-width:1500px;' +
    'overflow:hidden;background:#000;box-shadow:0 0 80px rgba(0,0,0,.8)}' +
    '.vnBg{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity .5s ease}' +
    '.vnBg.show{opacity:1}' +
    '#vnScene{position:absolute;inset:0;transition:filter .3s ease;will-change:transform,filter}' +
    '#vnBgWrap{position:absolute;inset:0;transform-origin:center;will-change:transform,filter}' +
    '#vnGrid{position:absolute;opacity:0;pointer-events:none;will-change:transform,opacity}' +
    '#vnGridInner{position:absolute;inset:0;animation:vnGridDrift 32s ease-in-out infinite}' +
    '@keyframes vnGridDrift{0%{transform:translate(-3%,-1.5%)}50%{transform:translate(3%,1.5%)}100%{transform:translate(-3%,-1.5%)}}' +
    '#vnGrid img{display:block}' +
    '#vnCgItems{position:absolute;inset:0;pointer-events:none;overflow:hidden}' +
    '.vnCgLayer{position:absolute;inset:0;will-change:transform}' +
    '.vnCgLayer img{position:absolute;left:50%;top:50%;will-change:transform,opacity}' +
    '#vnBlocker{position:absolute;inset:0;background-color:rgba(0,0,0,0);pointer-events:none}' +
    '.vnCurtain{position:absolute;left:0;right:0;height:0;background:#000;pointer-events:none}' +
    '#vnCurtainTop{top:0}#vnCurtainBottom{bottom:0}' +
    '#vnSticker{position:absolute;left:50%;top:30%;transform:translateX(-50%);max-width:80%;text-align:center;' +
    'text-shadow:0 2px 12px #000;opacity:0;transition:opacity .3s;pointer-events:none;font-weight:600}' +
    '#vnSticker.show{opacity:1}' +
    '#vnSprites{position:absolute;inset:0;pointer-events:none}' +
    '.vnSlot{position:absolute;inset:0}' +
    '.vnSlot img{position:absolute;width:auto;object-fit:contain;transform:translateX(-50%);' +
    'transition:left .4s ease,bottom .4s ease,height .4s ease,opacity .4s ease,filter .3s ease}' +
    '.vnSlot .vnShadow{position:absolute;display:none;transform:translateX(-50%);pointer-events:none;' +
    '-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;' +
    'transition:left .4s ease,bottom .4s ease,height .4s ease,opacity .4s ease}' +
    '#vnCG{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity .45s ease}' +
    '#vnCG.show{opacity:1}' +
    '#vnSubtitle{position:absolute;top:40%;left:50%;transform:translateX(-50%);max-width:74%;text-align:center;' +
    'font-size:clamp(16px,2.2vw,28px);text-shadow:0 2px 14px #000;opacity:0;transition:opacity .3s}' +
    '#vnSubtitle.show{opacity:1}' +
    /* текстбокс как в игре: чёрный градиент снизу вверх, без рамки */
    '#vnTextbox{position:absolute;left:0;right:0;bottom:0;min-height:30%;display:flex;align-items:flex-end;' +
    'padding:0 9% 5%;pointer-events:none;opacity:0;transition:opacity .25s;' +
    'background:linear-gradient(to top,rgba(0,0,0,.92) 0%,rgba(0,0,0,.6) 42%,rgba(0,0,0,0) 100%)}' +
    '#vnTextbox.show{opacity:1}' +
    /* имя слева в колонке (~20% от края), текст правее на той же строке */
    '#vnLine{display:flex;align-items:flex-start;width:100%;padding-left:11%}' +
    '#vnName{flex:0 0 16%;color:#c4ccd6;font-weight:600;letter-spacing:.02em;padding-right:2%;' +
    'font-size:clamp(13px,1.4vw,20px);line-height:1.55;text-shadow:0 1px 6px #000;text-align:left;' +
    'overflow-wrap:break-word}' +
    '#vnText{flex:1 1 auto;font-weight:500;font-size:clamp(15px,1.65vw,23px);line-height:1.55;min-height:1.55em;' +
    'text-shadow:0 1px 8px rgba(0,0,0,.9)}' +
    '#vnLine.noname #vnName{display:none}' +
    '#vnLine.noname{padding-left:20%}' +
    '#vnBarL{position:absolute;top:14px;left:16px;display:flex;gap:8px;z-index:5}' +
    '#vnBarR{position:absolute;top:14px;right:16px;display:flex;gap:8px;align-items:center;z-index:5}' +
    '#vnBarL button,#vnBarR button{background:rgba(10,14,22,.5);color:#dfe6f2;border:1px solid rgba(185,205,235,.25);' +
    'border-radius:.45em;padding:.3em .7em;font:600 13px Manrope,system-ui,sans-serif;cursor:pointer;' +
    '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}' +
    '#vnBarL button:hover,#vnBarR button:hover{background:rgba(42,54,74,.7)}' +
    '#vnBarL button.on,#vnBarR button.on{background:rgba(120,140,175,.8);color:#fff}' +
    '#vnRoot.vn-ui-hidden #vnTextbox,#vnRoot.vn-ui-hidden #vnSubtitle,' +
    '#vnRoot.vn-ui-hidden #vnBarL,#vnRoot.vn-ui-hidden #vnBarR{opacity:0;pointer-events:none}' +
    '#vnLogPanel{position:absolute;inset:6% 8%;background:rgba(8,10,16,.94);border:1px solid rgba(185,205,235,.2);' +
    'border-radius:12px;padding:22px 26px;overflow-y:auto;z-index:6;font-size:16px;line-height:1.6}' +
    '.vnLogRow{margin-bottom:11px}.vnLogRow b{color:#8fb6e8}';

  // ---------- старт ----------
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUI);
  else buildUI();
})();
