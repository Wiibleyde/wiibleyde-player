// ── Constants ─────────────────────────────────────────────────────────
const RETRY_DELAY = 200;

// Last resort: used when a speaker carries no radius and Lua sent no shared one.
const DEFAULT_RADIUS = 5;

// Per-speaker delay spread, in seconds. The same waveform reaching several
// PannerNodes comb-filters badly; staggering arrival decorrelates them and
// doubles as propagation delay. Cycled over 8 steps to stay under audible echo.
const SPEAKER_DECORRELATION = 0.007;

// ── URL parameters → frozen config ───────────────────────────────────
const _params = new URLSearchParams(window.location.search);

function _flag(name) {
    const raw = _params.get(name);
    if (raw === null) return false;
    return ['', 'true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const config = Object.freeze({
    app:                     _params.get('app')                     ?? 'live',
    stream:                  _params.get('stream')                  ?? 'livestream',
    eip:                     _params.get('eip'),
    muted:                   _params.get('muted')                   !== 'false',
    autoplay:                _params.get('autoplay')                !== 'false',
    controls:                _flag('controls'),
    playsinline:             _params.get('playsinline')             !== 'false',
    disablePictureInPicture: _flag('disablePictureInPicture'),
    spatial3d:               _flag('spatial3d'),
    led:                     _flag('led'),
    noOfflineImage:          _flag('noOfflineImage'),
    host:                    _params.get('host')                    ?? 'rtc-stream.wiibleyde.dev',
    protocol:                _params.get('protocol')                ?? 'https',
    zone:                    _params.get('zone')                    ?? '',
    screenName:              _params.get('screenName')              ?? '',
    eventName:               _params.get('eventName')              ?? '',
});

if (config.led) document.body.classList.add('led');

const _whepQuery = new URLSearchParams({ app: config.app, stream: config.stream });
if (config.eip) _whepQuery.set('eip', config.eip);
const WHEP_URL = `${config.protocol}://${config.host}/rtc/v1/whep/?${_whepQuery}`;

// ── DOM references ────────────────────────────────────────────────────
const video     = document.getElementById('v');
const offlineImg = document.getElementById('offline-img');

// A display:none <img> still downloads its src, and offline.png is ~350 KB per DUI.
if (config.noOfflineImage) offlineImg?.remove();

// ── Audio state ───────────────────────────────────────────────────────
let audioCtx    = null;
let currentPc   = null;
let streamSource = null;
let pannerNodes = [];
let delayNodes  = [];
let gainNode    = null;
let compressor  = null;

let speakers    = [{ x: 0, y: 0, z: 0, radius: DEFAULT_RADIUS }];
let defaultRadius = DEFAULT_RADIUS;

// ── Audio context helpers ─────────────────────────────────────────────
// AudioContext is created lazily so it is never constructed before the
// stream starts. In FiveM (CEF) it starts freely; in a real browser it
// starts suspended until a user gesture resumes it.

function getAudioCtx() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
}

function setListenerPosition(x, y, z) {
    if (!audioCtx) return;
    const l = audioCtx.listener;
    if (l.positionX) {
        l.positionX.value = x;
        l.positionY.value = y;
        l.positionZ.value = z;
    } else {
        l.setPosition(x, y, z);
    }
}

function setListenerOrientation(fx, fy, fz, ux, uy, uz) {
    if (!audioCtx) return;
    const l = audioCtx.listener;
    if (l.forwardX) {
        l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
        l.upX.value      = ux; l.upY.value      = uy; l.upZ.value      = uz;
    } else {
        l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
}

// refDistance = closest point at full volume (20 % of radius)
// maxDistance = beyond this point volume stops decreasing
function applyPannerDistanceConfig(panner, radius) {
    const r = Number(radius);
    const safe = Number.isFinite(r) && r > 0 ? r : defaultRadius;
    panner.refDistance   = Math.max(1, safe * 0.2);
    panner.maxDistance   = Math.max(panner.refDistance, safe);
    panner.rolloffFactor = 1;
}

function setPannerPosition(panner, { x, y, z }) {
    if (panner.positionX) {
        panner.positionX.value = x;
        panner.positionY.value = y;
        panner.positionZ.value = z;
    } else {
        panner.setPosition(x, y, z);
    }
}

// Accepts { x, y, z }, { x, y, z, radius }, or the legacy { coordinates, radius }.
// Rejects rather than throws so one bad entry cannot poison the whole rig.
function normalizeSpeaker(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const c = entry.coordinates ?? entry;
    const x = Number(c.x), y = Number(c.y), z = Number(c.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    const r = Number(entry.radius);
    return { x, y, z, radius: Number.isFinite(r) && r > 0 ? r : defaultRadius };
}

// Rebuilding HRTF panners is not free, so a same-length update only rewrites
// AudioParams instead of tearing the fan-out down and recreating it.
function updateSpeakers(next) {
    speakers = next;
    if (pannerNodes.length === next.length) {
        next.forEach((spk, i) => {
            setPannerPosition(pannerNodes[i], spk);
            applyPannerDistanceConfig(pannerNodes[i], spk.radius);
        });
        return;
    }
    connectSpeakers();
}

// ── DOM helpers ───────────────────────────────────────────────────────
function showOffline() {
    video.style.display = 'none';
    if (config.noOfflineImage) return;
    offlineImg?.classList.add('visible');
}

function showVideo() {
    offlineImg?.classList.remove('visible');
    video.style.display = '';
}

// ── WebRTC / player helpers ───────────────────────────────────────────
function closeCurrentPc() {
    if (!currentPc) return;
    currentPc.onconnectionstatechange = null;
    currentPc.ontrack = null;
    currentPc.close();
    currentPc = null;
}

// disconnect() drops only a node's outgoing edges, so source→delay and
// source→panner have to be cut at streamSource. Nothing else hangs off it.
function disconnectSpeakers() {
    streamSource?.disconnect();
    delayNodes.forEach(n => n.disconnect());
    pannerNodes.forEach(n => n.disconnect());
    delayNodes  = [];
    pannerNodes = [];
}

function teardownAudio() {
    disconnectSpeakers();
    streamSource = null;
    if (gainNode)   { gainNode.disconnect();   gainNode   = null; }
    if (compressor) { compressor.disconnect(); compressor = null; }
}

// N coincident sources add coherently, so normalise by sqrt(N) to keep a
// listener standing inside the cluster from clipping.
function applyOutputGain() {
    if (!gainNode) return;
    const n = Math.max(1, pannerNodes.length);
    gainNode.gain.value = (config.muted ? 0 : 1) / Math.sqrt(n);
}

// A lone speaker has nothing to sum with, so it skips the compressor and keeps
// the exact signal path single-screen setups had before speaker rigs existed.
function applyOutputStage() {
    if (!gainNode || !compressor) return;
    gainNode.disconnect();
    gainNode.connect(pannerNodes.length > 1 ? compressor : getAudioCtx().destination);
}

// An AudioNode output feeds many inputs natively, so the stream is decoded
// once no matter how many speakers hang off it.
//
//   MediaStreamSource ─┬─→ [Delay] → Panner(spk0) ─┐
//                      ├─→ [Delay] → Panner(spk1) ─┼─→ Gain → Compressor → out
//                      └─→ [Delay] → Panner(spkN) ─┘
function connectSpeakers() {
    if (!streamSource || !gainNode) return;
    disconnectSpeakers();

    const ctx = getAudioCtx();

    speakers.forEach((spk, i) => {
        const panner = ctx.createPanner();
        panner.panningModel  = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.coneInnerAngle = 360;
        panner.coneOuterAngle = 360;
        panner.coneOuterGain  = 0;
        applyPannerDistanceConfig(panner, spk.radius);
        setPannerPosition(panner, spk);

        let head = streamSource;
        const offset = (i % 8) * SPEAKER_DECORRELATION;
        if (speakers.length > 1 && offset > 0) {
            const delay = ctx.createDelay(1);
            delay.delayTime.value = offset;
            streamSource.connect(delay);
            delayNodes.push(delay);
            head = delay;
        }

        head.connect(panner);
        panner.connect(gainNode);
        pannerNodes.push(panner);
    });

    applyOutputStage();
    applyOutputGain();
}

// Called after the graph is (re)built so the panners get fresh coordinates
// even when the DUI was recycled.
function requestSoundSync() {
    if (!config.spatial3d || !config.zone || !config.screenName || !config.eventName) return;
    // Only CEF pages served from nui:// inject this shim. Evaluating it while
    // building the fetch argument would throw a ReferenceError past .catch().
    if (typeof GetParentResourceName !== 'function') return;
    fetch(`https://${GetParentResourceName()}/${config.eventName}:dui:requestSoundSync`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ zone: config.zone, screenName: config.screenName }),
    }).catch(() => {});
}

function routeAudioThrough3D() {
    teardownAudio();
    if (!video.srcObject?.getAudioTracks().length) return;

    const ctx = getAudioCtx();
    ctx.resume().catch(() => {});

    streamSource = ctx.createMediaStreamSource(video.srcObject);

    gainNode = ctx.createGain();
    compressor = ctx.createDynamicsCompressor();
    compressor.connect(ctx.destination);

    connectSpeakers();

    requestSoundSync();
}

// ── Player ────────────────────────────────────────────────────────────
async function play() {
    closeCurrentPc();

    // No iceServers: SRS advertises a public host candidate, so the browser
    // always dials outward and opens its own NAT binding. A srflx candidate
    // would never win the pair, and setLocalDescription resolves before
    // gathering finishes anyway — the offer is POSTed without it. Dropping
    // STUN removes a DNS lookup plus a round-trip from every attempt.
    const pc = new RTCPeerConnection({
        bundlePolicy: 'max-bundle',
    });
    currentPc = pc;

    pc.ontrack = ({ streams }) => {
        if (video.srcObject !== streams[0]) video.srcObject = streams[0];
    };

    pc.onconnectionstatechange = () => {
        if (pc !== currentPc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            teardownAudio();
            closeCurrentPc();
            showOffline();
            setTimeout(start, RETRY_DELAY);
        }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    let res;
    try {
        res = await fetch(WHEP_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body:    offer.sdp,
        });
    } catch (err) {
        closeCurrentPc();
        throw err;
    }

    if (!res.ok) {
        closeCurrentPc();
        throw new Error(`WHEP error: ${res.status}`);
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

    // Always start muted so autoplay is allowed by the browser, then
    // restore the desired state once playback is running.
    video.muted      = true;
    video.autoplay   = config.autoplay;
    video.controls   = config.controls;
    video.playsInline = config.playsinline;
    if (config.disablePictureInPicture) video.disablePictureInPicture = true;

    video.addEventListener('playing', showVideo, { once: true });
    await video.play();

    if (config.spatial3d) {
        routeAudioThrough3D();
    } else {
        video.muted = config.muted;
    }
}

function start() {
    play().catch(() => {
        teardownAudio();
        closeCurrentPc();
        showOffline();
        setTimeout(start, RETRY_DELAY);
    });
}

// ── FiveM DUI/NUI message handler ────────────────────────────────────
// Send from Lua: SendDuiMessage(duiHandle, json.encode({ ... }))
//
// 'position'       — send every frame (CreateThread loop)
//   { type='position',
//     coordinates = { x=px, y=py, z=pz },  -- GetEntityCoords(PlayerPedId())
//     camera      = { x=cx, y=cy, z=cz } } -- forward unit vector from cam matrix
//
// 'screenPosition' — send once on init (or when a speaker moves)
//   { type='screenPosition',
//     coordinates = { x=sx, y=sy, z=sz },
//     radius      = sr }
//
//   or, for a rig, entries with or without their own radius. A speaker with
//   no radius falls back to the top-level `radius`, then to DEFAULT_RADIUS:
//   { type='screenPosition',
//     radius   = sr,
//     speakers = { { x=, y=, z= },
//                  { x=, y=, z=, radius= } } }
window.addEventListener('message', ({ data }) => {
    if (data.type === 'position') {
        setListenerPosition(data.coordinates.x, data.coordinates.y, data.coordinates.z);
        setListenerOrientation(data.camera.x, data.camera.y, data.camera.z, 0, 0, 1);
        return;
    }

    if (data.type === 'screenPosition') {
        // Read the shared fallback first so bare speakers can inherit it.
        const shared = Number(data.radius);
        if (Number.isFinite(shared) && shared > 0) defaultRadius = shared;

        const raw = Array.isArray(data.speakers) ? data.speakers
                  : data.speakers                ? [data.speakers]
                  : [data];

        const next = raw.map(normalizeSpeaker).filter(Boolean);
        if (!next.length) return;

        updateSpeakers(next);
        return;
    }
});

// ── Bootstrap ─────────────────────────────────────────────────────────
showOffline();
start();
