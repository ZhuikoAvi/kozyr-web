/*
 * «Козырь» в браузере без Android-хоста (iPhone и любые телефоны).
 * Подключается после основного скрипта index.html и подменяет сеть:
 *  • хозяин — стол (GameHost из Kotlin, собран в kozyr-core.js) крутится прямо на этой странице;
 *  • гости соединяются с хозяином напрямую (WebRTC, без интернета и без сервера);
 *    адреса передаются QR-кодами: хозяин показывает код → гость сканирует → гость показывает ответ → хозяин сканирует.
 * Сообщения — тот же JSON, что у Android-хоста по WebSocket, поэтому весь интерфейс игры общий.
 */
"use strict";
(function () {
  var VERSION = "1.21";
  var mode = null;          // null | "host" | "guest"
  var hostObj = null, localLink = null, peers = [], pending = null;
  var guestPc = null, guestDc = null;
  var camGranted = false, scanStream = null, scanTimer = 0;

  function core() {
    var g = window.kozyrCore;
    if (!g) throw new Error("kozyr-core.js не загрузился");
    var w = (g.ru && g.ru.kozyr && g.ru.kozyr.web) || g;
    return w;
  }
  function log() { try { console.log.apply(console, ["[kz]"].concat([].slice.call(arguments))) } catch (e) {} }

  // ---------------------------------------------------------------- QR
  function qrImg(text, px) {
    var q = qrcode(0, "L"); q.addData(text); q.make();
    var n = q.getModuleCount(), cell = Math.max(2, Math.floor((px || 260) / (n + 8)));
    return '<img alt="QR" style="background:#fff;border-radius:10px;padding:6px;max-width:100%;image-rendering:pixelated" src="' + q.createDataURL(cell, 4) + '">';
  }

  /** Камера + распознавание QR (jsQR). cb(text) — один раз. Можно вставить код вручную. */
  function scan(title, hint, cb) {
    stopScan();
    overlay('<h2>' + title + '</h2><div class="dim" style="margin-bottom:6px">' + hint + '</div>' +
      '<div style="position:relative;width:min(78vw,320px);margin:0 auto"><video id="kzv" playsinline muted autoplay style="width:100%;border-radius:12px;background:#000;display:block"></video>' +
      '<div style="position:absolute;inset:18%;border:3px solid var(--gold);border-radius:12px"></div></div>' +
      '<div id="kzscanmsg" class="dim" style="margin:6px 0">Включаю камеру…</div>' +
      '<details style="margin:6px 0;text-align:left"><summary class="dim">Камера не работает? Вставить код</summary><div class="row" style="margin-top:6px"><input id="kzcode" placeholder="код"><button onclick="kzPaste()">OK</button></div></details>' +
      '<button class="sec" onclick="kzCancel()">Отмена</button>');
    var done = false;
    function finish(t) { if (done) return; done = true; stopScan(); cb(t) }
    window.kzPaste = function () { var t = ($("kzcode").value || "").trim(); if (t) finish(t) };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("kzscanmsg").textContent = "Камера недоступна — вставьте код вручную"; return }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(function (stream) {
      camGranted = true;
      if (done || !$("kzv")) { stream.getTracks().forEach(function (t) { t.stop() }); return }
      scanStream = stream;
      var v = $("kzv"); v.srcObject = stream; v.setAttribute("playsinline", ""); try { v.play() } catch (e) {}
      $("kzscanmsg").textContent = "Наведите камеру на QR-код";
      var c = document.createElement("canvas"), ctx = c.getContext("2d", { willReadFrequently: true });
      (function tick() {
        if (done || !scanStream) return;
        if (v.readyState >= 2 && v.videoWidth) {
          var w = Math.min(720, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
          c.width = w; c.height = h; ctx.drawImage(v, 0, 0, w, h);
          var r = null; try { r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" }) } catch (e) {}
          if (r && r.data) { try { navigator.vibrate && navigator.vibrate(40) } catch (e) {} finish(r.data); return }
        }
        scanTimer = setTimeout(tick, 120);
      })();
    }).catch(function (e) {
      log("camera", e);
      if ($("kzscanmsg")) $("kzscanmsg").textContent = "Нет доступа к камере. Разрешите камеру (Настройки → Safari → Камера) или вставьте код вручную.";
    });
  }
  function stopScan() {
    clearTimeout(scanTimer);
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop() }); scanStream = null }
  }
  window.kzCancel = function () {
    stopScan(); overlay("");
    if (pending && pending.pc && !pending.link) { try { pending.pc.close() } catch (e) {} pending = null }
    if (mode == "guest" && (!guestDc || guestDc.readyState != "open")) dropGuest();
  };

  /** Safari и Chrome показывают настоящий адрес телефона в сети только после разрешения камеры. */
  function warmCamera() {
    if (camGranted || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve();
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (s) { camGranted = true; s.getTracks().forEach(function (t) { t.stop() }) })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- WebRTC и коды
  function newPc() { return new RTCPeerConnection({ iceServers: [] }) }

  function gathered(pc) {
    return new Promise(function (res) {
      if (pc.iceGatheringState == "complete") return res();
      var t = setTimeout(res, 4000);
      pc.addEventListener("icegatheringstatechange", function () { if (pc.iceGatheringState == "complete") { clearTimeout(t); res() } });
    });
  }

  function hexToB64(hex) { var s = ""; hex.split(":").forEach(function (h) { s += String.fromCharCode(parseInt(h, 16)) }); return btoa(s) }
  function b64ToHex(b) { var s = atob(b), o = []; for (var i = 0; i < s.length; i++) { var h = s.charCodeAt(i).toString(16).toUpperCase(); o.push(h.length < 2 ? "0" + h : h) } return o.join(":") }

  /** SDP → короткий код: «K1,o|a,ufrag,pwd,отпечаток,setup,адрес/порт;…». */
  function pack(sdp, role) {
    function m(re) { var x = sdp.match(re); return x ? x[1].trim() : "" }
    var cands = [], seen = {};
    sdp.split(/\r?\n/).forEach(function (l) {
      var x = l.match(/^a=candidate:\S+ (\d+) udp \d+ (\S+) (\d+) typ (host|srflx)/i);
      if (x && x[1] == "1") { var k = x[2] + "/" + x[3]; if (!seen[k]) { seen[k] = 1; cands.push(k) } }
    });
    return ["K1", role, m(/a=ice-ufrag:(.*)/), m(/a=ice-pwd:(.*)/), hexToB64(m(/a=fingerprint:sha-256 (.*)/i)), m(/a=setup:(.*)/), cands.join(";")].join(",");
  }
  function unpack(text) {
    text = String(text || "").trim();
    var i = text.indexOf("#j="); if (i >= 0) text = text.slice(i + 3);
    try { text = decodeURIComponent(text) } catch (e) {}
    var p = text.split(",");
    if (p.length < 7 || p[0] != "K1") return null;
    return { r: p[1], u: p[2], p: p[3], f: b64ToHex(p[4]), s: p[5], c: p[6] ? p[6].split(";").map(function (c) { var q = c.split("/"); return { ip: q[0], port: q[1] } }) : [] };
  }
  function toSdp(d) {
    var l = ["v=0", "o=- " + Date.now() + " 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0", "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
      "a=ice-ufrag:" + d.u, "a=ice-pwd:" + d.p, "a=ice-options:trickle", "a=fingerprint:sha-256 " + d.f,
      "a=setup:" + d.s, "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144"];
    d.c.forEach(function (c, i) { l.push("a=candidate:" + (i + 1) + " 1 udp " + (2113937151 - i) + " " + c.ip + " " + c.port + " typ host generation 0") });
    l.push("a=end-of-candidates");
    return l.join("\r\n") + "\r\n";
  }
  function joinUrl(code) { return location.href.split("#")[0].split("?")[0] + "#j=" + code }
  function noNet(code) { return !unpack(code).c.length }

  function codeBox(code, url) {
    return qrImg(url || code, 270) +
      '<div class="row" style="justify-content:center;margin-top:6px">' +
      '<button class="sec" style="padding:8px 10px;font-size:13px" onclick="kzCopy(\'' + (url || code).replace(/'/g, "") + '\')">📋 Копировать код</button></div>';
  }
  window.kzCopy = function (t) {
    try { navigator.clipboard.writeText(t).then(function () { toast("Скопировано") }, function () { prompt("Скопируйте код:", t) }) }
    catch (e) { prompt("Скопируйте код:", t) }
  };
  var NONET = '<div class="banner" style="text-align:left">Телефон не в сети. Включите Wi‑Fi (интернет не нужен) или подключитесь к точке доступа другого телефона — и попробуйте снова.</div>';

  // ---------------------------------------------------------------- хозяин
  window.kzHost = function () {
    if (!me.name) { show("setup"); return }
    try {
      var C = core();
      hostObj = new C.WebHost("Стол " + me.name, me.id);
    } catch (e) { alert("Не удалось создать стол: " + e.message); return }
    mode = "host"; peers = []; pending = null;
    localLink = hostObj.join(function (t) { var m; try { m = JSON.parse(t) } catch (e) { return } window.onMsg(m) }, function () {});
    hello();
    keepAwake();
    warmCamera();
  };

  window.kzInvite = function () {
    if (mode != "host") return;
    if (pending && pending.pc && !pending.link) { try { pending.pc.close() } catch (e) {} }
    var pc = newPc(), dc = pc.createDataChannel("kz", { ordered: true });
    var peer = { pc: pc, dc: dc, link: null };
    pending = peer;
    overlay('<h2>Приглашение</h2><div class="dim">Готовлю код…</div>');
    dc.onopen = function () {
      peer.link = hostObj.join(function (t) { if (dc.readyState == "open") { try { dc.send(t) } catch (e) {} } },
        function () { setTimeout(function () { try { pc.close() } catch (e) {} }, 800) });
      peers.push(peer); if (pending === peer) pending = null;
      overlay(""); toast("Игрок подключился 🎉"); sfx("win");
    };
    dc.onmessage = function (e) { if (peer.link) peer.link.receive(e.data) };
    dc.onclose = function () { if (peer.link) peer.link.disconnect(); peers = peers.filter(function (p) { return p !== peer }) };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState == "failed" && !peer.link) overlay('<h2>Не соединилось</h2><div class="dim">Проверьте, что оба телефона в одной Wi‑Fi сети или на одной точке доступа, и пригласите ещё раз.</div><br><button onclick="kzInvite()">Пригласить ещё раз</button> <button class="sec" onclick="overlay(\'\')">Закрыть</button>');
    };
    warmCamera().then(function () { return pc.createOffer() }).then(function (o) { return pc.setLocalDescription(o) })
      .then(function () { return gathered(pc) }).then(function () {
        if (pending !== peer) return;
        var code = pack(pc.localDescription.sdp, "o");
        overlay('<h2>➕ Пригласить игрока</h2>' + (noNet(code) ? NONET : "") +
          '<div class="dim" style="margin-bottom:6px"><b>1.</b> Гость открывает «Козырь» → «Присоединиться» и наводит камеру на этот код (или обычной камерой iPhone).</div>' +
          codeBox(code, joinUrl(code)) +
          '<div class="dim" style="margin:10px 0 6px"><b>2.</b> Гость покажет свой код — отсканируйте его:</div>' +
          '<button style="width:100%" onclick="kzScanAnswer()">📷 Сканировать ответ гостя</button><br><br>' +
          '<button class="sec" onclick="kzCancel()">Отмена</button>');
      }).catch(function (e) { overlay('<h2>Ошибка</h2><div class="dim">' + esc(e.message || e) + '</div><br><button class="sec" onclick="overlay(\'\')">Закрыть</button>') });
  };

  window.kzScanAnswer = function () {
    var peer = pending;
    if (!peer) return;
    scan("Ответ гостя", "Наведите камеру на код на экране гостя", function (t) {
      var d = unpack(t);
      if (!d || d.r != "a") { toast("Это не ответ гостя — отсканируйте код с его экрана"); kzScanAnswer(); return }
      overlay('<h2>Соединяю…</h2><div class="dim">Секунду</div>');
      peer.pc.setRemoteDescription({ type: "answer", sdp: toSdp(d) }).catch(function (e) {
        overlay('<h2>Не получилось</h2><div class="dim">' + esc(e.message || e) + '</div><br><button onclick="kzInvite()">Пригласить ещё раз</button>');
      });
      setTimeout(function () {
        if (!peer.link && pending === peer) overlay('<h2>Не соединилось</h2><div class="dim">Телефоны не видят друг друга. Оба должны быть в одной Wi‑Fi сети или на точке доступа одного из телефонов. Иногда помогает выключить и включить Wi‑Fi.</div><br><button onclick="kzInvite()">Пригласить ещё раз</button> <button class="sec" onclick="overlay(\'\')">Закрыть</button>');
      }, 15000);
    });
  };

  function closeHost() {
    try { hostObj && hostObj.close() } catch (e) {}
    peers.forEach(function (p) { try { p.pc.close() } catch (e) {} });
    if (pending) { try { pending.pc.close() } catch (e) {} }
    hostObj = null; localLink = null; peers = []; pending = null;
  }

  // ---------------------------------------------------------------- гость
  window.kzJoin = function (codeFromLink) {
    if (!me.name) { pendingJoin = codeFromLink || ""; show("setup"); return }
    if (codeFromLink) { joinWith(codeFromLink); return }
    scan("Присоединиться", "Наведите камеру на QR-код на экране хозяина стола", joinWith);
  };

  function joinWith(text) {
    var d = unpack(text);
    if (!d || d.r != "o") {
      if (/^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(text)) { location.href = text; return }   // QR из Android-приложения
      toast("Это не код стола"); return;
    }
    dropGuest();
    mode = "guest";
    var pc = newPc(); guestPc = pc;
    overlay('<h2>Подключаюсь…</h2><div class="dim">Готовлю ответ для хозяина</div>');
    pc.ondatachannel = function (e) {
      var dc = e.channel; guestDc = dc;
      dc.onopen = function () { overlay(""); hello() };
      dc.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data) } catch (x) { return } window.onMsg(m) };
      dc.onclose = function () {
        if (mode != "guest" || guestDc !== dc) return;
        guestDc = null;
        overlay('<h2>Связь с хозяином потеряна</h2><div class="dim">Попросите хозяина нажать «➕» и отсканируйте его код ещё раз — вы вернётесь на своё место.</div><br>' +
          '<button onclick="kzJoin()">📷 Сканировать код хозяина</button> <button class="sec" onclick="kzExit()">Выйти</button>');
      };
    };
    warmCamera().then(function () { return pc.setRemoteDescription({ type: "offer", sdp: toSdp(d) }) })
      .then(function () { return pc.createAnswer() }).then(function (a) { return pc.setLocalDescription(a) })
      .then(function () { return gathered(pc) }).then(function () {
        if (guestPc !== pc || (guestDc && guestDc.readyState == "open")) return;
        var code = pack(pc.localDescription.sdp, "a");
        overlay('<h2>Покажите хозяину</h2>' + (noNet(code) ? NONET : "") +
          '<div class="dim" style="margin-bottom:6px">Хозяин нажимает «Сканировать ответ гостя» и наводит камеру на этот код.</div>' +
          codeBox(code) + '<div class="dim" style="margin-top:8px">Как только хозяин отсканирует — вы за столом.</div><br>' +
          '<button class="sec" onclick="kzCancel()">Отмена</button>');
      }).catch(function (e) {
        overlay('<h2>Не получилось</h2><div class="dim">' + esc(e.message || e) + '</div><br><button onclick="kzJoin()">Ещё раз</button> <button class="sec" onclick="kzCancel()">Закрыть</button>');
      });
  }

  function dropGuest() {
    if (guestDc) { try { guestDc.close() } catch (e) {} }
    if (guestPc) { try { guestPc.close() } catch (e) {} }
    guestDc = null; guestPc = null;
    if (mode == "guest") mode = null;
  }
  window.kzExit = function () { overlay(""); dropGuest(); mode = null; lobby = null; st = null; show("rooms") };

  // ---------------------------------------------------------------- подмена сети index.html
  function hello() { window.send({ t: "hello", id: me.id, name: me.name, avatar: me.avatar, version: PROTO, deckStyle: myDeck(), profile: card() }) }

  window.send = function (o) {
    var t = JSON.stringify(o);
    if (mode == "host" && localLink) localLink.receive(t);
    else if (mode == "guest" && guestDc && guestDc.readyState == "open") { try { guestDc.send(t) } catch (e) {} }
  };
  window.connect = function () {};
  window.loadRooms = function () {};
  window.leave = function () {
    if (mode == "host") {
      if (!confirm("Закрыть стол? Все гости отключатся.")) return;
      closeHost();
    } else if (mode == "guest") {
      window.send({ t: "leave" });
      setTimeout(dropGuest, 300);
    }
    mode = null; lobby = null; st = null; overlay(""); show("rooms");
  };
  var origOnMsg = window.onMsg;
  window.onMsg = function (m) {
    if (m.t == "closed") {
      if (mode == "guest") dropGuest();
      if (mode == "host") closeHost();
      mode = null;
    }
    origOnMsg(m);
  };

  // лобби: вместо адреса стола — приглашение по QR
  var origRenderLobby = window.renderLobby;
  window.renderLobby = function () {
    origRenderLobby();
    var img = $("inviteQr"); if (img) { img.removeAttribute("src"); img.style.display = "none" }
    var url = $("inviteUrl"); if (url) url.style.display = "none";
    var box = $("kzInv");
    if (!box && img) { box = document.createElement("div"); box.id = "kzInv"; img.parentNode.appendChild(box) }
    if (!box) return;
    var panel = box.parentNode;
    if (mode == "host") {
      panel.style.display = "";
      box.innerHTML = '<button style="width:100%" onclick="kzInvite()">➕ Пригласить игрока</button>' +
        '<div class="dim" style="margin-top:6px">Каждого гостя приглашайте по очереди: вы показываете код, он — свой ответ. Все — в одной Wi‑Fi сети или на точке доступа одного телефона, интернет не нужен.</div>';
    } else panel.style.display = "none";
  };
  var origRender = window.render;
  window.render = function () {
    origRender();
    var b = $("kzInvBtn"); if (b) b.style.display = mode == "host" ? "flex" : "none";
  };

  // ---------------------------------------------------------------- главный экран
  var pendingJoin = null;
  function buildHome() {
    $("rooms").innerHTML =
      '<div class="top"><div class="ib" onclick="show(\'setup\')">👤</div><div class="t">♠ Козырь</div><div id="coinsTop" style="color:var(--gold);font-weight:700"></div></div>' +
      '<div class="scroll">' +
      '<div id="installHint" class="banner" style="display:none">📲 Добавьте «Козырь» на экран «Домой»: кнопка «Поделиться» <b>⬆︎</b> внизу Safari → «На экран „Домой“». Тогда игра откроется и без интернета.</div>' +
      '<button style="width:100%;margin:6px 0 10px;padding:16px" onclick="kzHost()">🃏 Создать стол</button>' +
      '<button class="blue" style="width:100%;padding:16px" onclick="kzJoin()">📷 Присоединиться к столу</button>' +
      '<div class="panel" style="margin-top:14px"><h2>Как играть вместе</h2><div class="dim" style="font-size:14px;line-height:1.45">' +
      '1. Все телефоны — в одной Wi‑Fi сети или на точке доступа одного из телефонов. Интернет не нужен.<br>' +
      '2. Один жмёт «Создать стол», в лобби — «➕ Пригласить игрока» и показывает QR-код.<br>' +
      '3. Гость жмёт «Присоединиться», наводит камеру на код, потом показывает хозяину свой код — хозяин сканирует. Готово!<br>' +
      '4. С ботами можно играть и одному: «Создать стол» → «+ Бот» → «Начать игру».<br><br>' +
      'Если стол создал Android с приложением «Козырь» — просто наведите камеру iPhone на QR-код в его лобби.</div></div>' +
      '<div class="dim" style="text-align:center;font-size:11px">Веб-версия ' + VERSION + '</div>' +
      '</div>';
    var g = $("game").querySelector(".top");
    if (g && !$("kzInvBtn")) { var b = document.createElement("div"); b.className = "ib"; b.id = "kzInvBtn"; b.style.display = "none"; b.textContent = "➕"; b.title = "Пригласить / вернуть игрока"; b.onclick = window.kzInvite; g.insertBefore(b, g.children[2]) }
  }
  var origShow = window.show;
  window.show = function (id) {
    origShow(id);
    if (id == "rooms" && pendingJoin !== null && me.name) { var c = pendingJoin; pendingJoin = null; window.kzJoin(c || undefined) }
  };

  function start() {
    buildHome();
    var h = location.hash;
    if (h.indexOf("#j=") == 0) { pendingJoin = h; try { history.replaceState(null, "", location.pathname) } catch (e) {} }
    if (!me.name) show("setup"); else show("rooms");
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function (e) { log("sw", e) });
  }
  start();
})();
