// ── Constants ─────────────────────────────────────────────────────────
const RETRY_DELAY = 1000;

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
// refDistance  = closest point at full volume  (25 % of radius)
// maxDistance  = beyond this point volume stops decreasing
function applyPannerDistanceConfig(radius = screenRadius) {
    const r = Number(radius);
    if (!Number.isFinite(r) || r <= 0) return;
    screenRadius = r;
    if (!pannerNode) return;
    pannerNode.refDistance  = Math.max(1, r * 0.25);
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

// ── Browser dev tools (disabled inside FiveM / nui: protocol) ─────────
if (window.location.protocol !== 'nui:') {
    // Chrome blocks AudioContext until a user gesture. This one-time button
    // unlocks it and starts the positional audio test loop.
    const unlockBtn = document.createElement('button');
    unlockBtn.textContent = '🔊 Click to unlock audio';
    unlockBtn.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:99;padding:6px 12px;cursor:pointer;font-size:13px';
    document.body.appendChild(unlockBtn);
    unlockBtn.addEventListener('click', () => {
        getAudioCtx().resume().then(() => {
            if (config.spatial3d && video.srcObject) routeAudioThrough3D();
            startPositionTest();
        });
        unlockBtn.remove();
    }, { once: true });

    // ── Positional audio test ─────────────────────────────────────────
    // The listener is fixed at the origin. The source lerps between waypoints
    // every TEST_STEP_DURATION ms, varying both direction and distance so that
    // both panning and volume attenuation are clearly audible.
    const TEST_STEP_DURATION = 5000;
    const TEST_POSITIONS = [
        { x:  0, y: 0, z:  -2, label: 'front-near' },
        { x:  0, y: 0, z:  -8, label: 'front-far'  },
        { x:  3, y: 0, z:   0, label: 'right-near' },
        { x:  9, y: 0, z:   0, label: 'right-far'  },
        { x:  0, y: 0, z:   4, label: 'back-near'  },
        { x:  0, y: 0, z:  12, label: 'back-far'   },
        { x: -3, y: 0, z:   0, label: 'left-near'  },
        { x: -9, y: 0, z:   0, label: 'left-far'   },
    ];

    let testIndex  = 0;
    let testRafId  = null;
    let testStepAt = null;

    function lerp(a, b, t) { return a + (b - a) * t; }

    function animateTest(now) {
        if (testStepAt === null) {
            testStepAt = now;
            const p = TEST_POSITIONS[testIndex % TEST_POSITIONS.length];
            console.log(`[posTest] → ${p.label}`);
        }

        const from = TEST_POSITIONS[testIndex % TEST_POSITIONS.length];
        const to   = TEST_POSITIONS[(testIndex + 1) % TEST_POSITIONS.length];
        const t    = Math.min((now - testStepAt) / TEST_STEP_DURATION, 1);

        updateSourcePosition(lerp(from.x, to.x, t), lerp(from.y, to.y, t), lerp(from.z, to.z, t));

        if (t >= 1) {
            testIndex++;
            testStepAt = now;
            console.log(`[posTest] → ${TEST_POSITIONS[testIndex % TEST_POSITIONS.length].label}`);
        }

        testRafId = requestAnimationFrame(animateTest);
    }

    function startPositionTest() {
        if (testRafId !== null) return;
        applyPannerDistanceConfig(5);
        setListenerPosition(0, 0, 0);
        setListenerOrientation(0, 0, -1, 0, 1, 0);
        testRafId = requestAnimationFrame(animateTest);
    }

    // Console helpers — mirror the FiveM message types for manual testing.
    window.forcePosition = (x, y, z) => {
        setListenerPosition(x, y, z);
        console.log(`Listener → (${x}, ${y}, ${z})`);
    };

    window.forceScreenPosition = (x, y, z, radius) => {
        applyPannerDistanceConfig(radius);
        updateSourcePosition(x, y, z);
        if (pannerNode) {
            console.log(`Screen → (${x}, ${y}, ${z}), radius ${screenRadius}`);
        } else {
            console.warn('pannerNode not ready — retry after stream starts');
        }
    };
}

// ── Bootstrap ─────────────────────────────────────────────────────────
showOffline();
start();
