// ── Constants ─────────────────────────────────────────────────────────
const RETRY_DELAY = 200;

// ── URL parameters → frozen config ───────────────────────────────────
const _params = new URLSearchParams(window.location.search);
const config = Object.freeze({
    app:                     _params.get('app')                     ?? 'live',
    stream:                  _params.get('stream')                  ?? 'livestream',
    eip:                     _params.get('eip'),
    muted:                   _params.get('muted')                   !== 'false',
    autoplay:                _params.get('autoplay')                !== 'false',
    controls:                _params.get('controls')                === 'true',
    playsinline:             _params.get('playsinline')             !== 'false',
    disablePictureInPicture: _params.get('disablePictureInPicture') === 'true',
    spatial3d:               _params.get('spatial3d')               === 'true',
    host:                    _params.get('host')                    ?? 'rtc-stream.bonnell.fr',
    protocol:                _params.get('protocol')                ?? 'https',
    zone:                    _params.get('zone')                    ?? '',
    screenName:              _params.get('screenName')              ?? '',
    eventName:               _params.get('eventName')              ?? '',
});

const _whepQuery = new URLSearchParams({ app: config.app, stream: config.stream });
if (config.eip) _whepQuery.set('eip', config.eip);
const WHEP_URL = `${config.protocol}://${config.host}/rtc/v1/whep/?${_whepQuery}`;

// ── DOM references ────────────────────────────────────────────────────
const video     = document.getElementById('v');
const offlineImg = document.getElementById('offline-img');

// ── Audio state ───────────────────────────────────────────────────────
let audioCtx    = null;
let currentPc   = null;
let streamSource = null;
let pannerNode  = null;
let gainNode    = null;
let screenPos   = { x: 0, y: 0, z: 0 };
let screenRadius = 5;

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

// Configure PannerNode distance rolloff from a world-space radius.
// refDistance  = closest point at full volume  (20 % of radius)
// maxDistance  = beyond this point volume stops decreasing (clamped at 20 %)
function applyPannerDistanceConfig(radius = screenRadius) {
    const r = Number(radius);
    if (!Number.isFinite(r) || r <= 0) return;
    screenRadius = r;
    if (!pannerNode) return;
    pannerNode.refDistance  = Math.max(1, r * 0.2);
    pannerNode.maxDistance  = Math.max(pannerNode.refDistance, r);
    pannerNode.rolloffFactor = 1;
}

// Move the audio source (screen/TV) and keep screenPos in sync.
function updateSourcePosition(x, y, z) {
    screenPos = { x, y, z };
    if (!pannerNode) return;
    pannerNode.positionX.value = x;
    pannerNode.positionY.value = y;
    pannerNode.positionZ.value = z;
}

// ── DOM helpers ───────────────────────────────────────────────────────
function showOffline() {
    video.style.display = 'none';
    offlineImg.classList.add('visible');
}

function showVideo() {
    offlineImg.classList.remove('visible');
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

function teardownAudio() {
    if (streamSource) { streamSource.disconnect(); streamSource = null; }
    if (pannerNode)   { pannerNode.disconnect();   pannerNode   = null; }
    if (gainNode)     { gainNode.disconnect();     gainNode     = null; }
}

// Ask the Lua resource to re-send screen position / radius data.
// Called after the audio graph is (re)built so the panner always has
// fresh coordinates even if the DUI was recycled.
function requestSoundSync() {
    if (!config.spatial3d || !config.zone || !config.screenName || !config.eventName) return;
    fetch(`https://${GetParentResourceName()}/${config.eventName}:dui:requestSoundSync`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ zone: config.zone, screenName: config.screenName }),
    }).catch(() => {});
}

// Wire the WebRTC MediaStream through a 3D PannerNode.
// Graph: MediaStreamSource → Panner → Gain → destination (speakers).
function routeAudioThrough3D() {
    teardownAudio();
    if (!video.srcObject?.getAudioTracks().length) return;

    const ctx = getAudioCtx();
    ctx.resume().catch(() => {});

    streamSource = ctx.createMediaStreamSource(video.srcObject);

    pannerNode = ctx.createPanner();
    pannerNode.panningModel  = 'HRTF';
    pannerNode.distanceModel = 'inverse';
    // Omnidirectional — the screen radiates in all directions.
    pannerNode.coneInnerAngle = 360;
    pannerNode.coneOuterAngle = 360;
    pannerNode.coneOuterGain  = 0;
    applyPannerDistanceConfig();
    updateSourcePosition(screenPos.x, screenPos.y, screenPos.z);

    gainNode = ctx.createGain();
    gainNode.gain.value = config.muted ? 0 : 1;

    streamSource.connect(pannerNode);
    pannerNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    requestSoundSync();
}

// ── Player ────────────────────────────────────────────────────────────
async function play() {
    closeCurrentPc();

    const pc = new RTCPeerConnection({
        iceServers:   [{ urls: 'stun:stun.l.google.com:19302' }],
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
// 'screenPosition' — send once on init (or when screen moves)
//   { type='screenPosition',
//     coordinates = { x=sx, y=sy, z=sz },  -- world coords of the screen entity
//     radius      = sr }                   -- attenuation radius for this screen
window.addEventListener('message', ({ data }) => {
    if (data.type === 'position') {
        setListenerPosition(data.coordinates.x, data.coordinates.y, data.coordinates.z);
        setListenerOrientation(data.camera.x, data.camera.y, data.camera.z, 0, 0, 1);
        return;
    }

    if (data.type === 'screenPosition') {
        applyPannerDistanceConfig(data.radius);
        updateSourcePosition(data.coordinates.x, data.coordinates.y, data.coordinates.z);
        return;
    }
});

// ── Bootstrap ─────────────────────────────────────────────────────────
showOffline();
start();
