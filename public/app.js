const app = document.getElementById('app');

const storage = {
  get playerId() {
    return localStorage.getItem('playerId');
  },
  set playerId(value) {
    localStorage.setItem('playerId', value);
  },
  get resumeToken() {
    return localStorage.getItem('resumeToken');
  },
  set resumeToken(value) {
    localStorage.setItem('resumeToken', value);
  },
  clear() {
    localStorage.removeItem('playerId');
    localStorage.removeItem('resumeToken');
  },
};

const ui = {
  pollTimer: null,
  flash: null,
  routeCache: null,
  busy: false,
  phase1ChangeMode: false,
  phase4DepositorView: 'notice',
  phase4WholesaleView: 'halt',
  playerMainScrollTop: 0,
};

function setFlash(type, text) {
  ui.flash = { type, text, at: Date.now() };
}

function clearFlash() {
  ui.flash = null;
}

function escapeHtml(input = '') {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatCurrencyPrecise(value) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function shortDate(value) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function timeUntil(expiry) {
  const ms = Math.max(0, Number(expiry || 0) - Date.now());
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${String(rem).padStart(2, '0')}s`;
}

function elapsedSince(startedAt) {
  const ms = Math.max(0, Date.now() - Number(startedAt || Date.now()));
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function clearPoll() {
  if (ui.pollTimer) {
    clearInterval(ui.pollTimer);
    ui.pollTimer = null;
  }
}

function startPoll(fn, interval = 2000) {
  clearPoll();
  ui.pollTimer = setInterval(fn, interval);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const json = await response.json().catch(() => ({ ok: false, error: 'Invalid server response' }));

  if (!response.ok || json.ok === false) {
    const error = new Error(json.error || `HTTP ${response.status}`);
    error.payload = json;
    throw error;
  }
  return json;
}

async function compressImageToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const maxWidth = 1400;
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.max(320, Math.floor(bitmap.width * scale));
  const height = Math.max(180, Math.floor(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

function extractLikelyNameFromOcr(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/[^A-Za-z\s]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 4);
  const candidates = lines
    .filter((line) => /^[A-Za-z ]+$/.test(line))
    .filter((line) => line.split(' ').length >= 2)
    .filter((line) => line.length <= 36);
  const best = candidates
    .map((line) => line.toUpperCase())
    .find((line) => !/GOVT|GOVERNMENT|ID|CARD|DOB|SEX|MALE|FEMALE|ADDRESS|INDIA|REPUBLIC|UNIQUE|IDENTITY/.test(line));
  return (best || '').replace(/\s+/g, ' ').trim();
}

function parseHashRoute() {
  const hash = location.hash || '#/hub';
  const raw = hash.replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const cleaned = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart;
  const route = cleaned || 'hub';
  const params = new URLSearchParams(queryPart || '');
  return { route, params };
}

function goto(route) {
  location.hash = `#/${route}`;
}

function renderFlash() {
  if (!ui.flash) return '';
  const className = ui.flash.type === 'error' ? 'error-box' : 'success-box';
  return `<div class="${className}">${escapeHtml(ui.flash.text)}</div>`;
}

async function renderHub() {
  clearFlash();
  app.innerHTML = `<div class="screen"><div class="panel hero-card"><p>Loading session...</p></div></div>`;

  async function draw() {
    try {
      const data = await request('/api/session');
      const session = data.session;
      const counts = data.counts;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(session.joinUrl)}`;

      app.innerHTML = `
        <div class="screen shell-grid">
          <section class="panel hero-card">
            <span class="pill">Granite Bank Run Simulator</span>
            <h1 class="hero-title">QR-first onboarding for all players, then live four-phase crisis control.</h1>
            <p class="hero-subtitle">Project this screen first. Students scan and join as guests. QR token expires, but each player gets a durable resume token so refresh never loses progress.</p>
            <div class="row">
              <a class="button btn-primary" href="#/projector">Open Projector</a>
              <a class="button btn-secondary" href="#/gm">Open Game Master</a>
              <button class="btn-secondary" id="rotate-token">Refresh QR Token</button>
            </div>
          </section>

          <section class="hub-grid">
            <article class="panel qr-card">
              <p class="kicker">Session Code</p>
              <h2 class="hero-title" style="font-size:2.2rem;margin:0;">${escapeHtml(session.code)}</h2>
              <p class="tiny">QR expires in ${timeUntil(session.joinTokenExpiresAt)}</p>
              <div class="qr-wrap" style="margin-top:10px;">
                <img alt="Join QR" src="${qrUrl}" />
              </div>
              <div class="separator"></div>
              <p class="tiny">Join URL</p>
              <p class="mono" style="font-size:0.78rem; word-break: break-all;">${escapeHtml(session.joinUrl)}</p>
              <div class="row">
                <button class="btn-primary" id="copy-link">Copy Join Link</button>
                <a class="button btn-secondary" href="#/join?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.joinToken)}">Open Join Page</a>
              </div>
            </article>

            <article class="panel info-card">
              <p class="kicker">Live Lobby Status</p>
              <div class="stat-grid">
                <div class="stat-card">
                  <span class="stat-label">Phase</span>
                  <div class="stat-value">${escapeHtml(session.phase.toUpperCase())}</div>
                </div>
                <div class="stat-card">
                  <span class="stat-label">Total Joined</span>
                  <div class="stat-value">${counts.total}</div>
                </div>
                <div class="stat-card">
                  <span class="stat-label">Depositor</span>
                  <div class="stat-value">${counts.depositor}</div>
                </div>
                <div class="stat-card">
                  <span class="stat-label">Wholesale</span>
                  <div class="stat-value">${counts.wholesale}</div>
                </div>
              </div>

              <div class="separator"></div>
              <p class="muted">Suggested presenter flow</p>
              <ol style="margin-top:4px;padding-left:16px;line-height:1.6;">
                <li>Show this QR for 60-90 seconds.</li>
                <li>Open game master and verify role counts.</li>
                <li>Move to projector and start Phase 1 manually.</li>
              </ol>
            </article>
          </section>
        </div>
      `;

      const rotate = document.getElementById('rotate-token');
      const copy = document.getElementById('copy-link');

      rotate?.addEventListener('click', async () => {
        try {
          await request('/api/session/rotate-join', { method: 'POST' });
          setFlash('success', 'QR refreshed.');
          await draw();
        } catch (error) {
          setFlash('error', error.message);
        }
      });

      copy?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(session.joinUrl);
          setFlash('success', 'Join link copied to clipboard.');
          await draw();
        } catch (error) {
          setFlash('error', 'Clipboard blocked. Copy link manually.');
          await draw();
        }
      });
    } catch (error) {
      app.innerHTML = `<div class="screen"><div class="panel hero-card"><h2>Session unavailable</h2><p>${escapeHtml(error.message)}</p></div></div>`;
    }
  }

  await draw();
  startPoll(draw, 5000);
}

async function renderJoin() {
  clearPoll();
  const { params } = parseHashRoute();
  const fromHashCode = params.get('code') || '';
  const fromHashToken = params.get('token') || '';
  let extractedName = '';
  let ocrStatus = 'Waiting for ID photo.';
  let ocrBusy = false;
  let quiz = [];
  let quizAnswers = {};
  let step = fromHashCode && fromHashToken ? 'qr' : 'qr_missing';
  let cameraStream = null;
  let cameraActive = false;
  let cameraIssue = '';

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    cameraActive = false;
  };

  const bindPreview = () => {
    const video = document.getElementById('join-camera-preview');
    if (!video || !cameraStream) return;
    video.srcObject = cameraStream;
    video.play().catch(() => {});
  };

  try {
    const quizResp = await request('/api/join/quiz');
    quiz = quizResp.questions || [];
  } catch (error) {
    setFlash('error', 'Failed to load qualification questions.');
  }

  const renderStep = () => {
    const codeValue = fromHashCode;
    const tokenValue = fromHashToken;
    app.innerHTML = `
      <div class="mobile-wrap">
        <section class="mobile-shell">
          <div class="mobile-inner join-layout" id="join-screen">
            <div class="topline">
              <strong>${shortDate(Date.now())}</strong>
              <div class="row gap-4"><span class="icon-chip">📶</span><span class="icon-chip">🔋</span></div>
            </div>
            <p class="pill">Verified Join</p>
            <h1 class="section-title" style="margin-top:14px;">Join Session</h1>
            <p class="section-subtitle">QR first, then ID photo, then 3 quick questions.</p>

            ${
              step === 'qr' || step === 'qr_missing'
                ? `
            <div class="panel join-step-card">
              <label class="tiny">Session Code</label>
              <input id="join-code" value="${escapeHtml(codeValue)}" placeholder="Scan QR or paste code" />
              <label class="tiny" style="margin-top:8px;display:block;">QR Token</label>
              <input id="join-token" value="${escapeHtml(tokenValue)}" placeholder="Scan QR or paste token" />
              <p class="tiny" style="margin-top:10px;">${
                step === 'qr' ? 'QR detected. Continue to camera capture.' : 'Scan the QR on projector to auto-fill these.'
              }</p>
              <div class="row" style="margin-top:12px;">
                <button id="join-continue-qr" class="btn-primary">Continue</button>
                <button id="join-resume" class="btn-secondary">Resume Existing</button>
              </div>
            </div>
            `
                : ''
            }

            ${
              step === 'id'
                ? `
            <div class="panel join-step-card">
              <label class="tiny">Step 1: Take ID Photo</label>
              <input id="join-id-photo" type="file" accept="image/*" capture="environment" style="display:none;" />
              <div class="camera-stack">
                ${
                  cameraActive
                    ? `<video id="join-camera-preview" class="camera-preview" autoplay playsinline muted></video>`
                    : `<div class="camera-placeholder">Camera preview will appear here</div>`
                }
                <div class="row">
                  <button id="join-open-camera" class="btn-secondary" style="width:100%;margin-top:8px;">📷 Open Camera</button>
                  <button id="join-take-photo" class="btn-primary" style="width:100%;margin-top:8px;" ${cameraActive ? '' : 'disabled'}>Take Photo</button>
                </div>
                <button id="join-upload-photo" class="btn-secondary" style="width:100%;margin-top:8px;">Upload Photo Instead</button>
              </div>
              ${cameraIssue ? `<p class="tiny" style="margin-top:8px;color:#ffd0d0;">${escapeHtml(cameraIssue)}</p>` : ''}
              <p class="tiny" style="margin-top:8px;">OCR: ${escapeHtml(ocrStatus)}</p>
              <p style="margin:4px 0 0;">Detected name: <strong>${escapeHtml(extractedName || 'Not detected')}</strong></p>
              <div class="row" style="margin-top:12px;">
                <button id="join-to-quiz" class="btn-primary" ${extractedName ? '' : 'disabled'}>Continue To Questions</button>
                <button id="join-back-qr" class="btn-secondary">Back</button>
              </div>
            </div>
            `
                : ''
            }

            ${
              step === 'quiz'
                ? `
            <div class="panel join-step-card">
              <label class="tiny">Step 2: Qualification (3 Questions)</label>
              ${quiz
                .map(
                  (q, idx) => `
                <div class="quiz-block">
                  <p class="quiz-q">Q${idx + 1}. ${escapeHtml(q.prompt)}</p>
                  <div class="quiz-options">
                    ${q.options
                      .map((opt) => {
                        const selected = quizAnswers[q.id] === opt.id;
                        return `<button class="quiz-opt ${selected ? 'selected' : ''}" data-quiz-q="${escapeHtml(q.id)}" data-quiz-a="${escapeHtml(opt.id)}">${escapeHtml(
                          opt.text
                        )}</button>`;
                      })
                      .join('')}
                  </div>
                </div>
              `
                )
                .join('')}
              <div class="join-sticky-cta">
                <button id="join-submit" class="btn-primary">Join Verified Session</button>
              </div>
            </div>
            `
                : ''
            }
            ${renderFlash()}
          </div>
        </section>
      </div>
    `;

    document.getElementById('join-resume')?.addEventListener('click', async () => {
      if (!storage.resumeToken) {
        setFlash('error', 'No saved player session on this device.');
        renderStep();
        return;
      }
      try {
        await request('/api/resume', { method: 'POST', body: { resumeToken: storage.resumeToken } });
        goto('player');
      } catch (error) {
        setFlash('error', 'Saved session not found. Join again.');
        storage.clear();
        renderStep();
      }
    });

    document.getElementById('join-continue-qr')?.addEventListener('click', () => {
      const code = document.getElementById('join-code')?.value.trim().toUpperCase();
      const token = document.getElementById('join-token')?.value.trim();
      if (!code || !token) {
        setFlash('error', 'Scan QR first or fill code+token.');
        renderStep();
        return;
      }
      location.hash = `#/join?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`;
      step = 'id';
      renderStep();
    });

    document.getElementById('join-back-qr')?.addEventListener('click', () => {
      stopCamera();
      step = 'qr';
      renderStep();
    });

    document.getElementById('join-open-camera')?.addEventListener('click', async () => {
      if (cameraActive || ui.busy || ocrBusy) return;
      cameraIssue = '';
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera API not supported in this browser.');
        }
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        cameraActive = true;
        ocrStatus = 'Camera ready. Frame your ID and tap Take Photo.';
        renderStep();
      } catch (error) {
        cameraIssue = `${error.message} Using upload fallback.`;
        ocrStatus = 'Camera blocked/unavailable. Upload an ID photo.';
        cameraActive = false;
        stopCamera();
        renderStep();
      }
    });

    const runOcrFromFile = async (file) => {
      if (ui.busy || ocrBusy) return;
      if (!file) return;
      try {
        ocrBusy = true;
        ocrStatus = 'Reading ID securely...';
        renderStep();
        const imageDataUrl = await compressImageToDataUrl(file);
        const ocr = await request('/api/ocr-name', {
          method: 'POST',
          body: { imageDataUrl },
        });
        extractedName =
          String(ocr.fullName || '').trim() ||
          String(ocr.fallbackName || '').trim() ||
          `GUEST ${Math.floor(1000 + Math.random() * 9000)}`;
        const confidencePct = Math.round(Number(ocr.confidence || 0) * 100);
        ocrStatus = String(ocr.fullName || '').trim()
          ? `Name detected (${confidencePct}% confidence).`
          : `Low-confidence OCR, assigned as "${extractedName}".`;
      } catch (error) {
        extractedName = `GUEST ${Math.floor(1000 + Math.random() * 9000)}`;
        ocrStatus = `OCR failed, assigned fallback name "${extractedName}".`;
      } finally {
        ocrBusy = false;
        renderStep();
      }
    };

    document.getElementById('join-upload-photo')?.addEventListener('click', () => {
      document.getElementById('join-id-photo')?.click();
    });

    document.getElementById('join-id-photo')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      await runOcrFromFile(file);
      event.target.value = '';
    });

    document.getElementById('join-take-photo')?.addEventListener('click', async () => {
      if (!cameraActive || !cameraStream || ui.busy || ocrBusy) return;
      const video = document.getElementById('join-camera-preview');
      if (!video || !video.videoWidth || !video.videoHeight) {
        ocrStatus = 'Camera not ready yet. Try again in a second.';
        renderStep();
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) {
        ocrStatus = 'Failed to capture image. Try again.';
        renderStep();
        return;
      }
      const captureFile = new File([blob], `id_capture_${Date.now()}.jpg`, { type: 'image/jpeg' });
      await runOcrFromFile(captureFile);
    });

    document.getElementById('join-to-quiz')?.addEventListener('click', () => {
      if (!extractedName) return;
      stopCamera();
      step = 'quiz';
      renderStep();
    });

    document.querySelectorAll('[data-quiz-q]').forEach((btn) => {
      btn.addEventListener('click', () => {
        quizAnswers[btn.dataset.quizQ] = btn.dataset.quizA;
        renderStep();
      });
    });

    document.getElementById('join-submit')?.addEventListener('click', async () => {
      if (ui.busy) return;
      ui.busy = true;
      try {
        if (!extractedName || extractedName.length < 3) throw new Error('Capture ID photo and detect name first.');
        for (const q of quiz) {
          if (!quizAnswers[q.id]) throw new Error('Please answer all 3 questions.');
        }
        const code = (params.get('code') || '').trim().toUpperCase();
        const token = (params.get('token') || '').trim();
        const data = await request('/api/join', {
          method: 'POST',
          body: { idExtractedName: extractedName, code, token, quizAnswers },
        });
        storage.playerId = data.player.id;
        storage.resumeToken = data.player.resumeToken;
        stopCamera();
        goto('player');
      } catch (error) {
        setFlash('error', error.message);
        renderStep();
      } finally {
        ui.busy = false;
      }
    });

    if (step === 'id' && cameraActive) bindPreview();
  };

  renderStep();
}

function getPlayerFooterHint(snapshot) {
  const p = snapshot.player;
  const phase = snapshot.session.phase;

  if (phase === 'phase1' && p.role === 'depositor') {
    if (ui.phase1ChangeMode) return 'Next: pick a new product and tap Confirm Product Change.';
    if (!p.phase1Confirmed) return 'Next: pick a product, set optional amount, then Confirm Deposit.';
    return 'Deposited: you can Add More Money or Change Product until Phase 2 starts.';
  }

  if (phase === 'phase1' && p.role === 'wholesale') {
    if (ui.phase1ChangeMode) return 'Next: pick a new facility and tap Deploy Capital.';
    if (!p.phase1Deployed) return 'Next: pick facility, review daily earnings, then Deploy Capital.';
    return 'Deployed: you can Change Facility until Phase 2 starts.';
  }

  if (phase === 'phase2') return 'Phase 2: decide quickly. Higher returns mean higher risk.';
  if (phase === 'phase3') return 'Phase 3: liquidity stress is active. Protect position or stay in.';
  if (phase === 'phase4') return 'Final window: last decision before rescue/collapse outcome.';
  if (phase === 'end') return 'Simulation complete. Review your label and final position.';
  return 'Waiting for game master to start Phase 1.';
}

function renderPlayerBottomNav(snapshot) {
  const roleText = snapshot.player.role === 'depositor' ? 'Saver View' : 'Lender View';
  const hint = getPlayerFooterHint(snapshot);
  return `
    <div class="bottom-status">
      <span class="status-left">${roleText}</span>
      <span class="status-center">${hint}</span>
      <span class="status-right">Live</span>
    </div>
  `;
}

function displayRole(role) {
  return role === 'depositor' ? 'SAVER' : 'BIG LENDER';
}

function productSimpleName(productId, fallback) {
  const map = {
    current: 'Money Anytime',
    notice_3m: 'Wait 3 Months',
    fixed_1y: 'Lock 1 Year',
    bond_3y: 'Lock 3 Years',
    premier_142: 'Super Return 14.2%',
  };
  return map[productId] || fallback || 'Not selected';
}

function facilitySimpleName(facilityId, fallback) {
  const map = {
    overnight: 'Take Back Tomorrow',
    week_1: 'Lock 1 Week',
    month_3: 'Lock 3 Months',
    year_1: 'Lock 12 Months',
  };
  return map[facilityId] || fallback || 'Not selected';
}

function playerPhaseTitle(role, phase) {
  const depositorMap = {
    lobby: 'Waiting for Phase 1',
    phase1: 'Pick Where To Save',
    phase2: 'Chase More Return?',
    phase3: 'Stay Or Exit?',
    phase4: 'Last Decision',
    end: 'Simulation Complete',
  };
  const wholesaleMap = {
    lobby: 'Waiting for Phase 1',
    phase1: 'Pick Lending Time',
    phase2: 'Raise Price Or Reduce',
    phase3: 'Roll Over Or Leave',
    phase4: 'Final Funding Call',
    end: 'Simulation Complete',
  };
  return role === 'depositor' ? depositorMap[phase] || 'Live Session' : wholesaleMap[phase] || 'Live Session';
}

function depositorPhaseCards(snapshot) {
  const phase = snapshot.session.phase;
  const p = snapshot.player;

  if (phase === 'phase1') {
    const products = [
      ['current', 'Money Anytime', '2.1%', 'Take out anytime'],
      ['notice_3m', 'Wait 3 Months', '5.4%', 'Short lock'],
      ['fixed_1y', 'Lock 1 Year', '7.2%', 'Medium lock'],
      ['bond_3y', 'Lock 3 Years', '9.8%', 'Long lock'],
    ];

    if (p.phase1Confirmed && !ui.phase1ChangeMode) {
      return `
        <div class="panel" style="padding:12px;">
          <p class="kicker" style="margin:0;">Deposited</p>
          <p style="margin:8px 0 0;"><strong>${escapeHtml(productSimpleName(p.product, p.productLabel))}</strong></p>
          <p style="margin:4px 0 0;">Balance: <strong>${formatCurrency(p.balance)}</strong></p>
          <p style="margin:4px 0 0;">Rate: <strong>${Number(p.productRate || 0).toFixed(1)}%</strong> per year</p>
          <p style="margin:4px 0 0;">Interest this product: <strong>${formatCurrency(p.phase1TickerInterest || 0)}</strong></p>
          <p style="margin:4px 0 0;">Banked interest: <strong>${formatCurrency(p.phase1BankedInterest || 0)}</strong></p>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-secondary action-btn" data-action="prompt_add_money">Add More Money</button>
          <button class="btn-primary action-btn" data-action="phase1_change_open">Change Product</button>
        </div>
      `;
    }

    const selected = p.phase1Confirmed ? p.phase1PendingProduct || p.product || '' : p.phase1DraftProduct || p.product || '';
    const previewRate = Number(p.phase1PreviewRate || 0);
    const previewTotal = Number(p.phase1PreviewTotal || 10000);
    const daily = (previewTotal * (previewRate / 100)) / 365;
    const sliderValue = Number(p.phase1DraftAdditional || 0);
    const showSlider = !p.phase1Confirmed;

    return `
      <p class="section-subtitle compact-subtitle">Tap one option, then lock your choice.</p>
      <div class="choice-grid choice-grid-compact">
        ${products
          .map(
            ([id, label, rate, sub]) => `
            <button class="choice-card ${selected === id ? 'active' : ''}" data-action="select_product" data-product="${id}">
              <div>
                <h3 class="choice-title">${label}</h3>
                <p class="choice-sub">${sub.toUpperCase()}</p>
              </div>
              <p class="choice-rate">${rate}</p>
            </button>
          `
          )
          .join('')}
      </div>
      ${
        showSlider
          ? `
        <div class="panel" style="padding:10px; margin-top:10px;">
          <p class="tiny" style="margin:0 0 8px;">Add more savings? (Optional)</p>
          <input class="phase1-slider" type="range" min="0" max="40000" step="500" value="${sliderValue}" data-range="phase1_additional" />
          <div class="row" style="justify-content:space-between; margin-top:6px;">
            <span class="tiny">0</span>
            <strong>${formatCurrency(sliderValue)}</strong>
            <span class="tiny">40k</span>
          </div>
        </div>
      `
          : ''
      }
      <div class="phase1-preview-card">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <span class="preview-label">Your Selection</span>
          <span class="preview-pill">${p.phase1Confirmed ? 'Pending Change' : 'Draft'}</span>
        </div>
        <h3 class="preview-name">${escapeHtml(productSimpleName(selected, 'Choose one above'))}</h3>
        <div class="preview-grid">
          <div class="preview-metric">
            <span>Total Deposit</span>
            <strong>${formatCurrency(previewTotal)}</strong>
          </div>
          <div class="preview-metric">
            <span>Interest Rate</span>
            <strong>${previewRate.toFixed(1)}% p.a.</strong>
          </div>
        </div>
        <p class="preview-earn">Estimated earning: <strong>${formatCurrencyPrecise(daily)}/day</strong></p>
      </div>
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        ${
          p.phase1Confirmed
            ? '<button class="btn-secondary action-btn" data-action="phase1_change_cancel">Cancel</button>'
            : '<span></span>'
        }
        <button class="btn-primary action-btn ${p.phase1Confirmed ? '' : 'action-span-2'}" data-action="phase1_confirm">${p.phase1Confirmed ? 'Confirm Product Change' : 'Confirm Deposit'}</button>
      </div>
    `;
  }

  if (phase === 'phase2') {
    if (p.withdrew) {
      return `
        <div class="panel" style="padding:12px;">
          <p class="kicker" style="margin:0;">Withdrawal Complete</p>
          <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">You received ${formatCurrency(p.phase2ExitPayout || p.balance)}</h3>
          <p style="margin:6px 0 0;">Loss from penalty: <strong>${formatCurrency(p.phase2ExitLoss || 0)}</strong></p>
          <p style="margin:6px 0 0;">You are now a spectator for the rest of the game.</p>
        </div>
        <div class="player-mini-stats" style="margin-top:10px;">
          <div class="mini-stat"><span>Final Score</span><strong>${formatCurrency(p.balance)}</strong></div>
          <div class="mini-stat"><span>Status</span><strong>Spectator</strong></div>
        </div>
      `;
    }

    const currentRate = Number(p.productRate || 0);
    const currentDaily = (Number(p.balance || 0) * currentRate) / 100 / 365;
    const premierRate = 14.2;
    const premierDaily = (Number(p.balance || 0) * premierRate) / 100 / 365;
    const sixMonthGain = (Number(p.balance || 0) * premierRate) / 100 / 2;
    const canUpgrade = !!p.phase2CanUpgrade;
    const peers = Number(p.phase2PremierPeers || 0);

    return `
      <div class="panel" style="padding:12px;">
        <p class="kicker" style="margin:0;">Your Account</p>
        <h3 class="section-title" style="font-size:1.25rem; margin-top:6px;">${escapeHtml(productSimpleName(p.product, p.productLabel))}</h3>
        <p style="margin:6px 0 0;">Balance: <strong>${formatCurrency(p.balance)}</strong></p>
        <p style="margin:4px 0 0;">Earning: <strong>${currentRate.toFixed(1)}%</strong> • ${formatCurrencyPrecise(currentDaily)}/day</p>
        <p style="margin:4px 0 0;">Interest so far: <strong>${formatCurrency(p.totalInterestAccrued || 0)}</strong></p>
      </div>
      ${
        canUpgrade
          ? `
      <div class="panel promo-card" style="margin-top:10px;">
        <p class="kicker" style="color:#1a1300; margin:0;">Special Offer</p>
        <h3 class="section-title" style="font-size:1.5rem; color:#1a1300; margin-top:4px;">Granite Premier Bond 14.2%</h3>
        <p style="margin:8px 0 0; color:#2e2000;">Market average is lower. ${peers} classmates already upgraded.</p>
        <p style="margin:6px 0 0; color:#2e2000;">On your balance: <strong>${formatCurrencyPrecise(premierDaily)}/day</strong></p>
        <p style="margin:4px 0 0; color:#2e2000;">6-month projection: <strong>${formatCurrency(Math.round(sixMonthGain))}</strong></p>
        <button class="btn-primary action-btn" style="margin-top:10px;" data-action="upgrade_premier">Upgrade Now</button>
      </div>
      `
          : `
      <div class="panel" style="padding:12px; margin-top:10px;">
        <p class="kicker" style="margin:0;">Premier Status</p>
        <p style="margin:6px 0 0;"><strong>Upgraded</strong> to 14.2% already.</p>
        <p style="margin:4px 0 0;">Banked interest from old product: ${formatCurrency(p.phase2BankedInterest || 0)}</p>
      </div>
      `
      }
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        <button class="btn-secondary action-btn" data-action="prompt_add_money">Add Money</button>
        <button class="btn-secondary action-btn" data-action="buy_hedge">Buy Hedge</button>
        <button class="btn-danger action-btn" data-action="early_exit">Early Exit</button>
        <button class="btn-secondary action-btn action-span-2" data-action="hold">Stay In Position</button>
      </div>
      <div class="panel" style="padding:12px; margin-top:10px;">
        <p class="kicker" style="margin:0;">Early Exit Cost</p>
        <p style="margin:6px 0 0;">Penalty: <strong>${Math.round(Number(p.phase2ExitPenaltyPct || 40))}% of principal</strong></p>
        <p style="margin:4px 0 0;">You lose: <strong>${formatCurrency(p.phase2ExitLossEstimate || 0)}</strong></p>
        <p style="margin:4px 0 0;">You receive: <strong>${formatCurrency(p.phase2ExitPayoutEstimate || 0)}</strong></p>
      </div>
    `;
  }

  if (phase === 'phase3') {
    if (p.withdrew) {
      return `
        <div class="panel" style="padding:12px;">
          <p class="kicker" style="margin:0;">Phase 3 Exit Complete</p>
          <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">You are now in spectator mode</h3>
          <p style="margin:6px 0 0;">Final available balance: <strong>${formatCurrency(p.balance)}</strong></p>
        </div>
      `;
    }

    const stage = p.phase3Stage || 'denial';
    const queueActive = p.phase3QueueState && p.phase3QueueState !== 'none';
    const loyaltyRate = 16.2;
    const todayEarned = (Number(p.balance || 0) * (Number(p.productRate || 0) / 100)) / 365;
    const queueHours = Number(p.phase3QueueEtaHours || 0).toFixed(1);
    const queueRef = p.phase3QueueRef || '#883921';

    if (queueActive) {
      if (stage === 'bridge') {
        return `
          <div class="panel" style="padding:12px; border-color:rgba(255,190,130,0.8);">
            <p class="kicker" style="margin:0;">Partial System Response</p>
            <p style="margin:6px 0 0;">Only protected balances are being prioritized right now.</p>
            <p style="margin:4px 0 0;">Request ${escapeHtml(queueRef)} • Queue position ${Math.max(1, Number(p.phase3QueuePosition || 1))}</p>
            <p style="margin:4px 0 0;">Current mode: <strong>${p.phase3QueueMode === 'protected' ? 'Protected amount first' : 'Full withdrawal'}</strong></p>
            <p style="margin:4px 0 0;">Estimated wait: <strong>${queueHours} hours</strong></p>
          </div>
          <div class="panel" style="padding:12px; margin-top:10px;">
            <p class="kicker" style="margin:0;">Choose Request Priority</p>
            <p style="margin:6px 0 0;">Protected amount up to ${formatCurrency(p.fscsLimit)} may clear sooner.</p>
          </div>
          <div class="action-grid action-grid-2" style="margin-top:10px;">
            <button class="btn-secondary action-btn" data-action="phase3_prioritize_protected">Prioritize Protected Amount</button>
            <button class="btn-secondary action-btn" data-action="phase3_keep_full_request">Keep Full Request</button>
            <button class="btn-danger action-btn action-span-2" data-action="phase3_cancel_request">Cancel Withdrawal Request</button>
          </div>
          <div class="panel" style="padding:12px; margin-top:10px;">
            <p class="kicker" style="margin:0;">Phase 4 Handoff</p>
            <p style="margin:6px 0 0;">Emergency liquidity talks are likely to leak. Final decision window is next.</p>
          </div>
        `;
      }

      return `
        <div class="panel leak-card" style="padding:12px;">
          <p class="kicker" style="margin:0; color:#ffe2e2;">Social Alert</p>
          <p style="margin:6px 0 0;">Queues are forming outside branches. Login traffic is spiking.</p>
        </div>
        <div class="panel" style="padding:12px; margin-top:10px;">
          <p class="kicker" style="margin:0;">Withdrawal Request</p>
          <p style="margin:6px 0 0;">Reference: <strong>${escapeHtml(queueRef)}</strong></p>
          <p style="margin:4px 0 0;">Amount: <strong>${formatCurrency(p.phase3QueueRequestedAmount || p.balance)}</strong></p>
          <p style="margin:4px 0 0;">Status: <strong>${escapeHtml(String(p.phase3QueueState || 'processing').toUpperCase())}</strong></p>
          <p style="margin:4px 0 0;">Est. wait time: <strong>${queueHours} hours</strong></p>
          <p style="margin:4px 0 0;">Queue position: <strong>${Math.max(1, Number(p.phase3QueuePosition || 1))}</strong></p>
          <p style="margin:8px 0 0;" class="tiny">Do not refresh this page. Refreshing can lose queue priority.</p>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-secondary action-btn action-span-2" data-action="hold">Keep Waiting</button>
          <button class="btn-danger action-btn action-span-2" data-action="phase3_cancel_request">Cancel Request</button>
        </div>
      `;
    }

    if (stage === 'denial') {
      return `
        <div class="panel" style="padding:12px;">
          <p class="kicker" style="margin:0;">BBC News • now</p>
          <p style="margin:6px 0 0;">Global credit markets are freezing. Central banks are convening.</p>
        </div>
        <div class="panel" style="padding:12px; margin-top:10px;">
          <p class="kicker" style="margin:0;">Your Product</p>
          <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">${escapeHtml(productSimpleName(p.product, p.productLabel))}</h3>
          <p style="margin:6px 0 0;">Total balance: <strong>${formatCurrency(p.balance)}</strong></p>
          <p style="margin:4px 0 0;">+${formatCurrencyPrecise(todayEarned)} earned today</p>
          <p style="margin:8px 0 0;"><strong>Loyalty bonus active:</strong> temporary rate boost to ${loyaltyRate.toFixed(1)}%</p>
          <p class="tiny" style="margin-top:6px;">Service update: online banking remains operational and secure.</p>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-secondary action-btn action-span-2" data-action="hold">Keep Calm & Continue</button>
        </div>
      `;
    }

    return `
      <div class="panel" style="padding:12px;">
        <p class="kicker" style="margin:0;">Market Alert • Realization</p>
        <p style="margin:6px 0 0;">Leaked report says RMBS assets are under pressure while the bank reassures stability.</p>
      </div>
      <div class="panel" style="padding:12px; margin-top:10px;">
        <p class="kicker" style="margin:0;">Need Liquidity?</p>
        <p style="margin:6px 0 0;">You can switch to Instant Access now.</p>
        <p style="margin:4px 0 0;">Break fee: <strong>${p.phase3SwitchFeePct || 15}% (${formatCurrency(p.phase3SwitchFeeAmount || 0)})</strong></p>
        <p style="margin:4px 0 0;">New available balance: <strong>${formatCurrency(p.phase3SwitchPayout || 0)}</strong></p>
      </div>
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        <button class="btn-secondary action-btn action-span-2" data-action="phase3_review_switch">Review Switch Offer</button>
        <button class="btn-secondary action-btn action-span-2" data-action="hold">Stay in Premier Bond</button>
      </div>
    `;
  }

  if (phase === 'phase4') {
    const mode = ui.phase4DepositorView || 'notice';
    const outcome = p.phase4Outcome || {};
    const report = snapshot.metrics.phase4RetailReport || {};
    const rankText = p.phase4Rank > 0 ? `#${p.phase4Rank} of ${snapshot.counts.total || 0}` : 'Pending';

    if (mode === 'claim') {
      return `
        <div class="panel gov-card" style="padding:14px;">
          <p class="kicker gov-kicker" style="margin:0;">Claim Assessment</p>
          <h3 class="section-title gov-title" style="font-size:1.25rem; margin-top:6px;">Status: ${escapeHtml(outcome.status || 'PENDING')}</h3>
          <p style="margin:6px 0 0;">Account type: <strong>${escapeHtml(outcome.accountType || 'N/A')}</strong></p>
          <p style="margin:6px 0 0;">Total balance: <strong>${formatCurrency(outcome.totalBalance || p.balance)}</strong></p>
          <p style="margin:4px 0 0;">FSCS guarantee cap: <strong>${formatCurrency(outcome.guaranteed || 0)}</strong></p>
          <p style="margin:4px 0 0;">Unprotected loss: <strong>${formatCurrency(outcome.loss || 0)}</strong></p>
          <div class="separator"></div>
          <p style="margin:0;">Payout timeline:</p>
          <p style="margin:6px 0 0;"><strong>• ${escapeHtml(outcome.timelinePrimary || 'Awaiting processing')}</strong></p>
          ${outcome.timelineSecondary ? `<p style="margin:4px 0 0;">• ${escapeHtml(outcome.timelineSecondary)}</p>` : ''}
          <div class="separator"></div>
          <p style="margin:0;">Lesson: ${escapeHtml(outcome.lesson || 'Liquidity outcomes are path-dependent in stress events.')}</p>
          <p style="margin:8px 0 0;">Final rank: <strong>${escapeHtml(rankText)}</strong> • Label: <strong>${escapeHtml(outcome.label || p.label || 'ACTIVE')}</strong></p>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-secondary action-btn" data-action="phase4_view_notice">Back To Notice</button>
          <button class="btn-secondary action-btn" data-action="phase4_view_report">View Class Report</button>
          <button class="btn-primary action-btn action-span-2" data-action="exit_simulation">Exit Simulation</button>
        </div>
      `;
    }

    if (mode === 'report') {
      const avgPanic = '04:12';
      return `
        <div class="panel gov-card" style="padding:14px;">
          <p class="kicker gov-kicker" style="margin:0;">Classroom Simulation Report</p>
          <h3 class="section-title gov-title" style="font-size:1.2rem; margin-top:6px;">The Northern Rock Effect</h3>
          <p style="margin:6px 0 0;">Bank status: <strong>${escapeHtml(report.bankStatusText || 'NATIONALIZED')}</strong></p>
          <p style="margin:4px 0 0;">Solvency was not the immediate trigger. Liquidity failure was.</p>
          <div class="separator"></div>
          <p style="margin:0;">Class statistics:</p>
          <p style="margin:6px 0 0;">• Total depositors: <strong>${report.totalDepositors || 0}</strong></p>
          <p style="margin:4px 0 0;">• Fully protected: <strong>${report.fullyProtected || 0}</strong></p>
          <p style="margin:4px 0 0;">• Suffered haircut: <strong>${report.sufferedHaircut || 0}</strong></p>
          <p style="margin:4px 0 0;">• Lost over £10k: <strong>${report.lostOver10k || 0}</strong></p>
          <div class="separator"></div>
          <p style="margin:0;">Key metric: Avg. time to first panic action <strong>${avgPanic}</strong></p>
          <p style="margin:4px 0 0;"><strong>"Solvency is an opinion. Liquidity is a fact."</strong></p>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-secondary action-btn" data-action="phase4_view_claim">View My Claim Status</button>
          <button class="btn-secondary action-btn" data-action="phase4_view_notice">Back To Notice</button>
          <button class="btn-primary action-btn action-span-2" data-action="exit_simulation">Exit Simulation</button>
        </div>
      `;
    }

    return `
      <div class="panel gov-card" style="padding:14px;">
        <p class="kicker gov-kicker" style="margin:0;">HM Treasury Notice</p>
        <h3 class="section-title gov-title" style="font-size:1.25rem; margin-top:6px;">Official Statement</h3>
        <p style="margin:6px 0 0;">To maintain financial stability, Granite Bank has been taken into temporary public ownership.</p>
        <p style="margin:8px 0 0;">What this means for you:</p>
        <p style="margin:4px 0 0;">1. Retail deposits are under government guarantee.</p>
        <p style="margin:4px 0 0;">2. FSCS protection limit applies immediately.</p>
        <p style="margin:4px 0 0;">3. Trading in bank equity is suspended.</p>
      </div>
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        <button class="btn-primary action-btn action-span-2" data-action="phase4_view_claim">View My Claim Status</button>
        <button class="btn-secondary action-btn action-span-2" data-action="phase4_view_report">View Class Report</button>
      </div>
    `;
  }

  if (phase === 'end') {
    const status = snapshot.session.bankStatus;
    return `
      <p class="pill">Simulation Complete</p>
      <h2 class="section-title" style="margin-top:14px;">Bank Status: ${status}</h2>
      <div class="panel" style="padding:14px; margin-top:12px;">
        <p class="kicker">Your Final Position</p>
        <h3 class="balance-value money-line" style="margin:6px 0;">${formatCurrency(p.balance)}</h3>
        <p>Label: <strong>${escapeHtml(p.label)}</strong></p>
        <p class="tiny">Score: ${p.score}</p>
        <button class="btn-secondary action-btn" data-action="noop">Await Debrief</button>
      </div>
    `;
  }

  return `<p>Waiting for game master to start Phase 1.</p>`;
}

function wholesalePhaseCards(snapshot) {
  const phase = snapshot.session.phase;
  const p = snapshot.player;

  if (phase === 'phase1') {
    const libor = Number(snapshot.metrics.liborPct || 0);
    const facilityDefs = [
      ['overnight', 'Overnight Repo', 8, '1 day rolling', 4],
      ['week_1', '1-Week Facility', 12, '7 days per rollover', 3],
      ['month_3', '3-Month Facility', 18, '90 days per rollover', 2],
      ['year_1', '12-Month Facility', 28, '365 days committed', 1],
    ];
    const selected = p.phase1Deployed ? p.phase1PendingFacility || p.facility || '' : p.phase1DraftFacility || p.facility || '';
    const deployed = !!p.phase1Deployed;
    const selectedDef = facilityDefs.find(([id]) => id === selected) || null;
    const deployedDef = facilityDefs.find(([id]) => id === p.facility) || null;
    const totalLenders = Number(snapshot.metrics.wholesaleDeployment?.totalCount || snapshot.counts.wholesale || 0);
    const deployedLenders = Number(snapshot.metrics.wholesaleDeployment?.deployedCount || 0);

    const options = [
      ['overnight', 'Overnight Repo', '+8 bps', 'Maximum flexibility'],
      ['week_1', '1-Week Facility', '+12 bps', 'Short commitment'],
      ['month_3', '3-Month Facility', '+18 bps', 'Medium commitment'],
      ['year_1', '12-Month Facility', '+28 bps', 'Highest spread'],
    ];

    if (deployed && !ui.phase1ChangeMode) {
      const ticker = Number(p.phase1TickerSpread || 0);
      const banked = Number(p.phase1BankedSpread || 0);
      const activeSpreadBps = deployedDef ? deployedDef[2] : 8;
      const activeRate = libor + activeSpreadBps / 100;
      const activeDaily = (Number(p.principal || 0) * (activeRate / 100)) / 365;
      return `
        <div class="panel" style="padding:12px;">
          <p class="kicker" style="margin:0;">Capital Deployed</p>
          <h3 class="preview-name" style="margin-top:8px;">${escapeHtml(facilitySimpleName(p.facility, p.facilityLabel))}</h3>
          <div class="preview-grid">
            <div class="preview-metric"><span>Amount</span><strong>${formatCurrency(p.principal)}</strong></div>
            <div class="preview-metric"><span>Rate</span><strong>${activeRate.toFixed(2)}%</strong></div>
            <div class="preview-metric"><span>Per day</span><strong>${formatCurrencyPrecise(activeDaily)}</strong></div>
            <div class="preview-metric"><span>Spread so far</span><strong>${formatCurrencyPrecise(banked + ticker)}</strong></div>
          </div>
        </div>
        <div class="panel" style="padding:10px; margin-top:10px;">
          <p class="tiny" style="margin:0;">Peer Activity: ${deployedLenders} of ${totalLenders} deployed</p>
          <div class="tiny" style="margin-top:6px;">
            Overnight ${snapshot.metrics.wholesaleDeployment?.byFacility?.overnight || 0} •
            1-Week ${snapshot.metrics.wholesaleDeployment?.byFacility?.week_1 || 0} •
            3-Month ${snapshot.metrics.wholesaleDeployment?.byFacility?.month_3 || 0} •
            12-Month ${snapshot.metrics.wholesaleDeployment?.byFacility?.year_1 || 0}
          </div>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-primary action-btn action-span-2" data-action="phase1_change_open">Change Facility</button>
        </div>
      `;
    }

    return `
      <div class="panel" style="padding:10px; margin-bottom:10px;">
        <p class="tiny" style="margin:0;">Market: LIBOR ${libor.toFixed(2)}% • Granite Bank A rated</p>
      </div>
      <p class="section-subtitle compact-subtitle">${deployed ? 'Choose replacement facility and deploy to switch.' : 'Choose your facility and deploy capital.'}</p>
      <div class="choice-grid choice-grid-compact">
        ${options
          .map(
            ([id, label, rate, sub]) => `
          <button class="choice-card ${selected === id ? 'active' : ''}" data-action="select_facility" data-facility="${id}">
            <div style="text-align:left;">
              <p class="choice-sub" style="margin:0; opacity:0.95;">LIBOR ${rate}</p>
              <h4 class="choice-title" style="margin-top:4px;">${label}</h4>
            </div>
            <div>
              <p class="choice-sub" style="margin:0;">${sub}</p>
              <p class="choice-sub" style="margin:4px 0 0;">Flexibility: ${
                id === 'overnight' ? '🔓🔓🔓🔓 4/4' : id === 'week_1' ? '🔓🔓🔓🔒 3/4' : id === 'month_3' ? '🔓🔓🔒🔒 2/4' : '🔓🔒🔒🔒 1/4'
              }</p>
              <p class="choice-sub" style="margin:4px 0 0;">Daily: ${formatCurrencyPrecise((Number(p.principal || 0) * ((libor + (id === 'overnight' ? 0.08 : id === 'week_1' ? 0.12 : id === 'month_3' ? 0.18 : 0.28)) / 100)) / 365)}</p>
            </div>
          </button>
        `
          )
          .join('')}
      </div>
      <div class="phase1-preview-card">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <span class="preview-label">Selected Facility</span>
          <span class="preview-pill">${deployed ? 'Pending Change' : 'Draft'}</span>
        </div>
        <h3 class="preview-name">${escapeHtml(selectedDef ? selectedDef[1] : 'Choose one above')}</h3>
        <div class="preview-grid">
          <div class="preview-metric">
            <span>Amount</span>
            <strong>${formatCurrency(p.principal)}</strong>
          </div>
          <div class="preview-metric">
            <span>Rate</span>
            <strong>${selectedDef ? (libor + selectedDef[2] / 100).toFixed(2) : libor.toFixed(2)}%</strong>
          </div>
        </div>
      </div>
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        ${deployed ? '<button class="btn-secondary action-btn" data-action="phase1_change_cancel">Cancel</button>' : '<span></span>'}
        <button class="btn-primary action-btn ${deployed ? '' : 'action-span-2'}" data-action="phase1_deploy">Deploy Capital</button>
      </div>
    `;
  }

  if (phase === 'phase2') {
    const libor = Number(snapshot.metrics.liborPct || 0);
    const spreadBps = (() => {
      if (p.facility === 'week_1') return 12;
      if (p.facility === 'month_3') return 18;
      if (p.facility === 'year_1') return 28;
      return 8;
    })();
    const demandBps = Number(p.spreadBpsOverride || 0);
    const effectiveRate = libor + (spreadBps + demandBps) / 100;
    const deployedAmount = Number(p.principal || 0) * (Number(p.exposurePct || 100) / 100);
    const daily = (deployedAmount * (effectiveRate / 100)) / 365;
    const spreadTotal = Number(p.phase1BankedSpread || 0) + Number(p.phase1TickerSpread || 0);
    const altGov = libor + 0.37;
    const altBanks = libor + 0.33;
    const totalPeers = Number(snapshot.metrics.phase2Wholesale?.totalCount || snapshot.counts.wholesale || 0);
    const livePeers = Number(snapshot.metrics.phase2Wholesale?.liveCount || totalPeers);
    const demandingPeers = Number(snapshot.metrics.phase2Wholesale?.demandingCount || 0);
    const basePeers = Math.max(0, livePeers - demandingPeers);
    const peerDots = Array.from({ length: Math.max(totalPeers, 1) })
      .map((_, idx) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;background:${idx < livePeers ? '#7eff9e' : 'rgba(255,255,255,0.28)'};"></span>`)
      .join('');
    return `
      <div class="panel" style="padding:12px;">
        <p class="kicker" style="margin:0;">Your Position</p>
        <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">${escapeHtml(facilitySimpleName(p.facility, p.facilityLabel))}</h3>
        <p style="margin:6px 0 0;">Deployed: <strong>${formatCurrency(Math.round(deployedAmount))}</strong></p>
        <p style="margin:4px 0 0;">Rate: <strong>${effectiveRate.toFixed(2)}%</strong>${demandBps ? ` (includes +${demandBps}bps demand)` : ''}</p>
        <p style="margin:4px 0 0;">Earning: <strong>${formatCurrencyPrecise(daily)}/day</strong></p>
        <p style="margin:4px 0 0;">Spread earned so far: <strong>${formatCurrencyPrecise(spreadTotal)}</strong></p>
      </div>
      <div class="panel" style="padding:12px; margin-top:10px;">
        <p class="kicker" style="margin:0;">Market Conditions Changing</p>
        <p style="margin:6px 0 0;">LIBOR: <strong>${libor.toFixed(2)}%</strong></p>
        <p style="margin:4px 0 0;">Alternative yields: Govt <strong>${altGov.toFixed(2)}%</strong> • Other banks <strong>${altBanks.toFixed(2)}%</strong></p>
      </div>
      <div class="panel" style="padding:12px; margin-top:10px;">
        <p class="kicker" style="margin:0;">Granite Credit Metrics</p>
        <p style="margin:6px 0 0;">LCR: <strong>${snapshot.metrics.lcr.toFixed(1)}%</strong> • NSFR: <strong>${snapshot.metrics.nsfr.toFixed(1)}%</strong></p>
        <p style="margin:4px 0 0;">Wholesale dependency: <strong>${snapshot.metrics.wholesaleDependencyPct.toFixed(1)}%</strong></p>
        <p style="margin:4px 0 0;">Credit rating says A, but metrics are stressed.</p>
      </div>
      <div class="panel" style="padding:12px; margin-top:10px;">
        <p class="kicker" style="margin:0;">Peer Activity</p>
        <div style="margin-top:8px;">${peerDots}</div>
        <p style="margin:6px 0 0;">${livePeers} of ${totalPeers} still deployed • ${basePeers} base • ${demandingPeers} demanding spread</p>
      </div>
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        <button class="btn-secondary action-btn action-span-2" data-action="maintain">Maintain Position</button>
        <button class="btn-secondary action-btn" data-action="prompt_demand_spread">Demand Higher Spread</button>
        <button class="btn-secondary action-btn" data-action="prompt_reduce_wholesale">Reduce Exposure</button>
        <button class="btn-secondary action-btn action-span-2" data-action="prompt_add_wholesale">Add More Capital</button>
      </div>
    `;
  }

  if (phase === 'phase3') {
    const peer = snapshot.metrics.phase3Wholesale || { totalCount: snapshot.counts.wholesale || 0, rolling: 0, hesitating: 0, refused: 0, refusalRatePct: 0, failureThresholdPct: 50 };
    const decisionSec = Math.max(0, Number(p.phase3DecisionSecondsLeft || 0));
    const timer = `${String(Math.floor(decisionSec / 60)).padStart(2, '0')}:${String(decisionSec % 60).padStart(2, '0')}`;
    const liveExposure = Number(p.phase3WholesaleLiveExposure || (p.principal || 0));
    const offerRate = Number(p.phase3WholesaleOfferRate || (snapshot.metrics.liborPct + 2));
    const oneDay = Number(p.phase3WholesaleOneDayOfferProfit || 0);
    const isRefused = !!p.refused;
    const rollingColor = '#8df4a8';
    const waitingColor = '#ffd98a';
    const refusedColor = '#ff8f8f';

    if (isRefused) {
      return `
        <div class="panel" style="padding:12px; border-color:rgba(255,120,120,0.8); background:rgba(255,80,80,0.2);">
          <p class="kicker" style="margin:0; color:#ffe2e2;">Order Confirmed</p>
          <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">Funds Recalled</h3>
          <p style="margin:6px 0 0;">Value: <strong>${formatCurrency(Math.round(liveExposure))}</strong></p>
          <p style="margin:4px 0 0;">Execution time: <strong>${shortDate(snapshot.serverTime)}</strong></p>
          <p style="margin:8px 0 0;">Your recall reduced Granite's available funding and signaled a confidence event to peers.</p>
          <p style="margin:4px 0 0;"><strong>Position secured.</strong> Monitoring continues from sidelines.</p>
        </div>
      `;
    }

    return `
      <div class="panel" style="padding:12px; border-color:rgba(255,176,120,0.8); background:rgba(16,18,24,0.68);">
        <p class="kicker" style="margin:0;">Market Alert: Liquidity Crunch</p>
        <p style="margin:6px 0 0;">Overnight LIBOR: <strong>${snapshot.metrics.liborPct.toFixed(2)}%</strong> • Credit spreads widening</p>
        <p style="margin:6px 0 0;">Counterparty: <strong>Granite Bank</strong> • Maturity due now</p>
        <p style="margin:4px 0 0;">Exposure: <strong>${formatCurrency(Math.round(liveExposure))}</strong></p>
        <p style="margin:4px 0 0;">Rollover offer: <strong>LIBOR + 200bps (${offerRate.toFixed(2)}%)</strong></p>
        <p style="margin:4px 0 0;">One-day yield if rolled: <strong>${formatCurrency(Math.round(oneDay))}</strong></p>
        <p style="margin:6px 0 0;">Decision required in: <strong>${timer}</strong></p>
      </div>
      <div class="panel" style="padding:12px; margin-top:10px; background:rgba(18,20,28,0.72);">
        <p class="kicker" style="margin:0;">Market Depth: Peer Activity</p>
        <p style="margin:6px 0 0; color:${rollingColor};">Rolling over: <strong>${peer.rolling}</strong></p>
        <p style="margin:4px 0 0; color:${waitingColor};">Hesitating: <strong>${peer.hesitating}</strong></p>
        <p style="margin:4px 0 0; color:${refusedColor};">Refused / recalled: <strong>${peer.refused}</strong></p>
        <p style="margin:8px 0 0;">Refusal rate: <strong>${Number(peer.refusalRatePct || 0).toFixed(1)}%</strong> • Failure threshold: <strong>${peer.failureThresholdPct || 50}%</strong></p>
      </div>
      <div class="panel" style="padding:12px; margin-top:10px;">
        <p class="kicker" style="margin:0;">Execution Decision</p>
        <p style="margin:6px 0 0;"><strong>Option A:</strong> Authorize rollover and keep earning at offered rate.</p>
        <p style="margin:4px 0 0;"><strong>Option B:</strong> Refuse rollover and recall principal immediately.</p>
      </div>
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        <button class="btn-secondary action-btn action-span-2" data-action="rollover">Authorize Rollover</button>
        <button class="btn-secondary action-btn action-span-2" data-action="punitive_spread">Authorize at +200bps</button>
        <button class="btn-secondary action-btn" data-action="partial_rollover">Reduce 25% (Partial)</button>
        <button class="btn-danger action-btn" data-action="refuse_rollover">Refuse & Recall</button>
      </div>
    `;
  }

  if (phase === 'phase4') {
    const mode = ui.phase4WholesaleView || 'halt';
    const outcome = p.phase4WholesaleOutcome || {};
    const report = snapshot.metrics.phase4WholesaleReport || {};

    if (mode === 'audit') {
      return `
        <div class="panel halt-card" style="padding:14px;">
          <p class="kicker" style="margin:0; color:#ffb0b0;">Risk Committee Audit Report</p>
          <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">Status: ${escapeHtml(outcome.status || 'PENDING')}</h3>
          <p style="margin:6px 0 0;">Action recorded: <strong>${escapeHtml(outcome.action || 'N/A')}</strong></p>
          <p style="margin:4px 0 0;">Current exposure: <strong>${formatCurrency(outcome.exposure || 0)}</strong></p>
          <div class="separator"></div>
          <p style="margin:0;">Performance review:</p>
          <p style="margin:6px 0 0;">• Principal preserved: <strong>${formatCurrency(outcome.preservedPrincipal || 0)}</strong></p>
          <p style="margin:4px 0 0;">• Missed one-day yield: <strong>${formatCurrency(outcome.missedYield || 0)}</strong></p>
          <p style="margin:4px 0 0;">• Recovery estimate: <strong>${escapeHtml(outcome.recoveryRate || 'N/A')}</strong></p>
          <p style="margin:4px 0 0;">• Timeline: <strong>${escapeHtml(outcome.timeline || 'N/A')}</strong></p>
          <div class="separator"></div>
          <p style="margin:0;">Market reputation: <strong>${escapeHtml(outcome.reputation || 'Under Review')}</strong></p>
          <p style="margin:4px 0 0;">Outcome: <strong>${escapeHtml(outcome.finalLabel || 'Pending')}</strong></p>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-secondary action-btn" data-action="phase4_wholesale_halt">Back To Halt Notice</button>
          <button class="btn-secondary action-btn" data-action="phase4_wholesale_report">Systemic Risk Analysis</button>
          <button class="btn-primary action-btn action-span-2" data-action="exit_simulation">End Simulation</button>
        </div>
      `;
    }

    if (mode === 'report') {
      return `
        <div class="panel halt-card" style="padding:14px;">
          <p class="kicker" style="margin:0; color:#ffb0b0;">Systemic Risk Analysis</p>
          <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">Who Killed Granite Bank?</h3>
          <p style="margin:6px 0 0;">Wholesale refusal rate: <strong>${Number(report.refusalRatePct || 0).toFixed(1)}%</strong></p>
          <p style="margin:4px 0 0;">Liquidity drained: <strong>${formatCurrency(report.liquidityDrained || 0)}</strong></p>
          <p style="margin:4px 0 0;">System status: <strong>${escapeHtml(report.statusText || 'UNDER REVIEW')}</strong></p>
          <div class="separator"></div>
          <p style="margin:0;">Lesson:</p>
          <p style="margin:6px 0 0;">Wholesale funding is highly flight-sensitive. Individual principal protection decisions can generate collective funding collapse.</p>
        </div>
        <div class="action-grid action-grid-2" style="margin-top:10px;">
          <button class="btn-secondary action-btn" data-action="phase4_wholesale_audit">Open Risk Audit</button>
          <button class="btn-secondary action-btn" data-action="phase4_wholesale_halt">Back To Halt Notice</button>
          <button class="btn-primary action-btn action-span-2" data-action="exit_simulation">End Simulation</button>
        </div>
      `;
    }

    return `
      <div class="panel halt-card" style="padding:14px;">
        <p class="kicker" style="margin:0; color:#ffb0b0;">Terminal Status: HALTED</p>
        <h3 class="section-title" style="font-size:1.2rem; margin-top:6px;">Market Data Feed Suspended</h3>
        <p style="margin:6px 0 0;">Notice from exchange: trading in Granite instruments is suspended.</p>
        <p style="margin:4px 0 0;">Notice from central bank: liquidity support facility activated.</p>
        <p style="margin:8px 0 0;">Your position is now locked. Compliance valuation in progress.</p>
      </div>
      <div class="action-grid action-grid-2" style="margin-top:10px;">
        <button class="btn-primary action-btn action-span-2" data-action="phase4_wholesale_audit">Access Risk Report</button>
        <button class="btn-secondary action-btn action-span-2" data-action="phase4_wholesale_report">View Systemic Analysis</button>
      </div>
    `;
  }

  if (phase === 'end') {
    return `
      <p class="pill">Simulation Complete</p>
      <h2 class="section-title money-line" style="margin-top:14px;">Final Position: ${formatCurrency(p.balance)}</h2>
      <div class="panel" style="padding:14px; margin-top:12px;">
        <p>Label: <strong>${escapeHtml(p.label)}</strong></p>
        <p class="tiny">Score: ${p.score}</p>
      </div>
    `;
  }

  return `<p>Waiting for game master to start Phase 1.</p>`;
}

function renderPlayerView(snapshot) {
  const existingMain = document.querySelector('.player-main');
  if (existingMain) {
    ui.playerMainScrollTop = existingMain.scrollTop;
  }

  const p = snapshot.player;
  if (snapshot.session.phase !== 'phase1') {
    ui.phase1ChangeMode = false;
  }
  if (snapshot.session.phase !== 'phase4') {
    ui.phase4DepositorView = 'notice';
    ui.phase4WholesaleView = 'halt';
  }
  const phaseBadge = snapshot.session.phase.startsWith('phase')
    ? `PHASE ${snapshot.session.phase.replace('phase', '')}`
    : snapshot.session.phase.toUpperCase();
  let primaryTag = '';
  if (p.role === 'depositor') {
    primaryTag = productSimpleName(p.product, p.productLabel);
  } else if (snapshot.session.phase === 'phase1') {
    const wholesaleCurrent = p.phase1Deployed ? p.phase1PendingFacility || p.facility : p.phase1DraftFacility || p.facility;
    primaryTag = facilitySimpleName(wholesaleCurrent, p.facilityLabel);
  } else {
    primaryTag = facilitySimpleName(p.facility, p.facilityLabel);
  }
  let secondaryTag = '';
  if (p.role === 'depositor') {
    if (snapshot.session.phase === 'phase1') {
      secondaryTag = p.phase1Confirmed ? 'Deposited' : 'Not deposited yet';
    } else if (p.withdrew) {
      secondaryTag = 'Spectator mode';
    } else {
      secondaryTag = `Unprotected ${formatCurrency(p.unprotectedAmount)}`;
    }
  } else {
    if (snapshot.session.phase === 'phase1') {
      secondaryTag = p.phase1Deployed ? 'Capital deployed' : 'Not deployed yet';
    } else {
      secondaryTag = `Exposure ${Math.round(p.exposurePct)}%`;
    }
  }
  const balanceLabel = formatCurrency(p.balance);
  const balanceTight = balanceLabel.length >= 13;

  app.innerHTML = `
    <div class="mobile-wrap">
      <section class="mobile-shell">
        <div class="mobile-inner player-layout" id="player-screen">
          <div class="topline">
            <strong>${shortDate(snapshot.serverTime)}</strong>
            <div class="row gap-4">
              <span class="icon-chip">🔔</span>
              <span class="icon-chip">👤</span>
            </div>
          </div>

          <div class="player-header">
            <div class="row" style="justify-content:space-between;">
              <span class="pill">${escapeHtml(displayRole(p.role))}</span>
              <span class="pill">${escapeHtml(phaseBadge)}</span>
            </div>
            <p class="balance-title">Available Balance</p>
            <h1 class="balance-value ${balanceTight ? 'tight' : ''}">${balanceLabel}</h1>
            <h2 class="section-title player-phase-title">${escapeHtml(playerPhaseTitle(p.role, snapshot.session.phase))}</h2>
            <div class="player-mini-stats">
              <div class="mini-stat"><span>Current</span><strong>${escapeHtml(primaryTag || 'Not selected')}</strong></div>
              <div class="mini-stat"><span>Status</span><strong>${escapeHtml(secondaryTag)}</strong></div>
            </div>
          </div>

          <div class="player-main">
            ${p.role === 'depositor' ? depositorPhaseCards(snapshot) : wholesalePhaseCards(snapshot)}
            ${renderFlash()}
          </div>

          ${renderPlayerBottomNav(snapshot)}
        </div>
      </section>
    </div>
  `;

  const screen = document.getElementById('player-screen');
  const playerMain = document.querySelector('.player-main');

  if (playerMain) {
    playerMain.scrollTop = ui.playerMainScrollTop;
    playerMain.addEventListener('scroll', () => {
      ui.playerMainScrollTop = playerMain.scrollTop;
    });
  }

  screen?.querySelectorAll('[data-range="phase1_additional"]').forEach((rangeEl) => {
    rangeEl.addEventListener('change', async () => {
      if (ui.busy) return;
      try {
        ui.busy = true;
        clearFlash();
        const additional = Number(rangeEl.value || 0);
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'phase1_set_additional', payload: { additional } },
        });
        await pullPlayerSnapshot();
      } catch (error) {
        setFlash('error', error.message);
        await pullPlayerSnapshot();
      } finally {
        ui.busy = false;
      }
    });
  });

  screen?.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || ui.busy) return;
    const actionType = target.dataset.action;
    if (!actionType || actionType === 'noop') return;

    try {
      if (actionType === 'phase1_change_open') {
        ui.phase1ChangeMode = true;
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'phase1_change_cancel') {
        ui.phase1ChangeMode = false;
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'phase4_view_notice') {
        ui.phase4DepositorView = 'notice';
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'phase4_view_claim') {
        ui.phase4DepositorView = 'claim';
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'phase4_view_report') {
        ui.phase4DepositorView = 'report';
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'phase4_wholesale_halt') {
        ui.phase4WholesaleView = 'halt';
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'phase4_wholesale_audit') {
        ui.phase4WholesaleView = 'audit';
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'phase4_wholesale_report') {
        ui.phase4WholesaleView = 'report';
        await pullPlayerSnapshot();
        return;
      }
      if (actionType === 'exit_simulation') {
        storage.clear();
        goto('hub');
        return;
      }

      ui.busy = true;
      clearFlash();
      if (actionType === 'prompt_add_money') {
        const room = Math.max(0, 50000 - Number(snapshot.player.principal || 0));
        if (room <= 0) {
          setFlash('error', 'You already reached the 50k cap.');
          return;
        }
        const input = window.prompt(`How much extra money to add? Max ${Math.floor(room)}`, String(Math.min(5000, Math.floor(room))));
        if (!input) return;
        const amount = Number(input);
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'add_money', payload: { amount } },
        });
        setFlash('success', 'Money added.');
      } else if (actionType === 'upgrade_premier') {
        const yes = window.confirm('Upgrade to Premier Bond 14.2% now? This is one-way in Phase 2.');
        if (!yes) return;
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'upgrade_premier', payload: {} },
        });
        setFlash('success', 'Upgraded to Premier Bond.');
      } else if (actionType === 'buy_hedge') {
        const full = window.confirm('Buy FULL hedge? Press Cancel for BASIC hedge.');
        const level = full ? 'full' : 'basic';
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'buy_hedge', payload: { level } },
        });
        setFlash('success', `${level === 'full' ? 'Full' : 'Basic'} hedge purchased.`);
      } else if (actionType === 'phase3_review_switch') {
        const fee = formatCurrency(snapshot.player.phase3SwitchFeeAmount || 0);
        const payout = formatCurrency(snapshot.player.phase3SwitchPayout || 0);
        const ok = window.confirm(
          `Switch to Instant Access?\nBreak fee: ${fee}\nNew available balance: ${payout}\nThis action is irreversible.`
        );
        if (!ok) return;
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'convert_current', payload: {} },
        });
        setFlash('success', 'Fee paid and switch submitted. Withdrawal request is now queued.');
      } else if (actionType === 'early_exit') {
        const loss = formatCurrency(snapshot.player.phase2ExitLossEstimate || 0);
        const first = window.confirm(`Early exit will cost ${loss}. Continue?`);
        if (!first) return;
        const second = window.confirm(`Final confirmation: you will permanently lose ${loss}.`);
        if (!second) return;
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'early_exit', payload: { confirmStep: 'double' } },
        });
        setFlash('success', 'Exit completed.');
      } else if (actionType === 'prompt_add_wholesale') {
        const input = window.prompt('How much more capital to add? Max 500,000,000', '50000000');
        if (!input) return;
        const amount = Number(input);
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'add_more', payload: { amount } },
        });
        setFlash('success', 'Exposure increased.');
      } else if (actionType === 'prompt_demand_spread') {
        const input = window.prompt('Demand extra spread in bps: choose 25, 75, or 150', '75');
        if (!input) return;
        const requested = Number(input);
        const level = requested === 150 ? 150 : requested === 75 ? 75 : 25;
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'demand_spread', payload: { level } },
        });
        setFlash('success', `Demanded +${level}bps spread.`);
      } else if (actionType === 'prompt_reduce_wholesale') {
        const input = window.prompt('Reduce exposure by percentage: 25, 50, or 75', '25');
        if (!input) return;
        const requested = Number(input);
        const pct = requested === 75 ? 75 : requested === 50 ? 50 : 25;
        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType: 'reduce_exposure', payload: { pct } },
        });
        setFlash('success', `Exposure reduced by ${pct}%.`);
      } else {
        const payload = {};
        if (target.dataset.product) payload.product = target.dataset.product;
        if (target.dataset.facility) payload.facility = target.dataset.facility;
        if (target.dataset.level) payload.level = Number(target.dataset.level);
        if (target.dataset.pct) payload.pct = Number(target.dataset.pct);

        await request('/api/action', {
          method: 'POST',
          body: { playerId: storage.playerId, actionType, payload },
        });
        const successMap = {
          select_product: 'Option selected.',
          hold: snapshot.session.phase === 'phase1' ? 'Phase 1 confirmed.' : 'Holding.',
          phase1_confirm: 'Deposit confirmed.',
          phase1_deploy: 'Capital deployed.',
          select_facility: 'Facility selected.',
          maintain: snapshot.session.phase === 'phase1' ? 'Capital deployed.' : 'Kept current action.',
          upgrade_premier: 'Upgraded to 14.2% option.',
          buy_hedge: 'Hedge purchased.',
          early_exit: 'Exited with penalty.',
          withdraw_now: 'Withdraw request sent.',
          withdraw_unprotected: 'Unprotected portion withdrawn.',
          partial_withdraw_unprotected: 'Unprotected portion withdrawn.',
          convert_current: 'Switched to money-anytime.',
          phase3_cancel_request: 'Withdrawal request cancelled.',
          phase3_prioritize_protected: 'Protected amount moved to priority queue.',
          phase3_keep_full_request: 'Full withdrawal request kept in queue.',
          demand_spread: 'Rate request sent.',
          reduce_exposure: 'Exposure reduced.',
          rollover: 'Continue lending.',
          punitive_spread: 'Requested +200bps.',
          refuse_rollover: 'Stop lending submitted.',
          partial_rollover: 'Partial rollover submitted.',
          final_hold: 'Final keep-lending submitted.',
          final_refuse: 'Final stop-lending submitted.',
          spread_panic: 'Alerts sent.',
        };
        setFlash('success', successMap[actionType] || 'Action submitted.');
      }

      if (actionType === 'phase1_confirm') {
        ui.phase1ChangeMode = false;
      }
      await pullPlayerSnapshot();
    } catch (error) {
      const phaseChanged = /Action not available/.test(error.message);
      if (phaseChanged) {
        setFlash('error', 'Phase changed. Pick one of the current phase actions.');
      } else {
        setFlash('error', error.message);
      }
      await pullPlayerSnapshot();
    } finally {
      ui.busy = false;
    }
  });
}

async function pullPlayerSnapshot() {
  if (!storage.playerId) {
    goto('join');
    return;
  }
  try {
    const snapshot = await request(`/api/state?playerId=${encodeURIComponent(storage.playerId)}`);
    if (!snapshot.player) {
      throw new Error('Player session missing. Rejoin required.');
    }
    renderPlayerView(snapshot);
  } catch (error) {
    setFlash('error', error.message);
    storage.clear();
    goto('join');
  }
}

async function renderPlayer() {
  clearPoll();
  if (!storage.resumeToken || !storage.playerId) {
    goto('join');
    return;
  }

  try {
    await request('/api/resume', {
      method: 'POST',
      body: { resumeToken: storage.resumeToken },
    });
  } catch (error) {
    storage.clear();
    goto('join');
    return;
  }

  await pullPlayerSnapshot();
  startPoll(pullPlayerSnapshot, 2000);
}

function renderPhaseSpecificProjector(snapshot) {
  const phase = snapshot.session.phase;

  if (phase === 'phase1') {
    const retail = snapshot.metrics.phase1Retail || { confirmedCount: 0, totalCount: 0, byProduct: {} };
    const retailByProduct = retail.byProduct || {};
    const wholesale = snapshot.metrics.wholesaleDeployment || { deployedCount: 0, totalCount: 0, byFacility: {} };
    const wholesaleByFacility = wholesale.byFacility || {};
    const gap03 = (snapshot.metrics.gapTable || []).find((row) => row.bucket === '0-3m') || { netGap: 0 };
    const flashCapacity = 20;
    const premierCount = Number(retailByProduct.bond_3y || 0);
    const flashSpotsLeft = Math.max(0, flashCapacity - premierCount);
    const topRetailLabel =
      Object.entries({
        'Current Account': Number(retailByProduct.current || 0),
        '3-Month Notice': Number(retailByProduct.notice_3m || 0),
        '1-Year Fixed': Number(retailByProduct.fixed_1y || 0),
        '3-Year Premier Bond': Number(retailByProduct.bond_3y || 0),
      }).sort((a, b) => b[1] - a[1])[0] || ['Current Account', 0];
    const topWholesaleLabel =
      Object.entries({
        'Overnight Repo': Number(wholesaleByFacility.overnight || 0),
        '1-Week Facility': Number(wholesaleByFacility.week_1 || 0),
        '3-Month Facility': Number(wholesaleByFacility.month_3 || 0),
        '12-Month Facility': Number(wholesaleByFacility.year_1 || 0),
      }).sort((a, b) => b[1] - a[1])[0] || ['Overnight Repo', 0];

    return `
      <div class="phase1-unified-grid">
        <article class="panel board-card phase1-unified-card">
          <p class="kicker">Funding Side: Retail Deposits</p>
          <p class="section-title" style="font-size:1.45rem;">Search For Yield (Behavioral Driver)</p>
          <p class="muted" style="margin-top:6px;">Confirmed: ${retail.confirmedCount}/${retail.totalCount} • Most selected: ${escapeHtml(topRetailLabel[0])} (${topRetailLabel[1]})</p>
          <div class="separator"></div>
          <div class="warning-chip" style="display:flex; justify-content:space-between; width:100%;">
            <span>3-Year Premier Bond: 9.8% annual return</span>
            <strong>${flashSpotsLeft} spots left</strong>
          </div>
          <p class="tiny" style="margin-top:10px;">Live retail flow: ${premierCount} savers shifted into long contractual maturity.</p>
        </article>

        <article class="panel board-card phase1-unified-card">
          <p class="kicker">Funding Side: Wholesale Markets</p>
          <p class="section-title" style="font-size:1.45rem;">Maturity Mismatch Formation</p>
          <p class="muted" style="margin-top:6px;">Deployed: ${wholesale.deployedCount}/${wholesale.totalCount} • Most selected: ${escapeHtml(topWholesaleLabel[0])} (${topWholesaleLabel[1]})</p>
          <div class="separator"></div>
          <div style="margin-top:8px;">
            <div class="row" style="justify-content:space-between;"><strong>0-3 Month Funding Concentration</strong><span>${snapshot.metrics.fundingConcentrationPct.toFixed(1)}%</span></div>
            <div style="height:14px;border-radius:999px;background:rgba(255,255,255,0.12);overflow:hidden;margin-top:8px;">
              <div style="height:100%;width:${Math.min(100, snapshot.metrics.fundingConcentrationPct)}%;background:linear-gradient(90deg,#ffd37f,#ff7a8d);"></div>
            </div>
          </div>
          <p class="tiny" style="margin-top:10px;">Live wholesale flow: ${wholesaleByFacility.overnight || 0} lenders in Overnight Repo, increasing short-term refinancing dependence.</p>
        </article>
      </div>
      <article class="panel board-card phase1-truth-bar">
        <div class="row" style="justify-content:space-between;">
          <p class="kicker" style="margin:0;">Gap Analysis (ALM View)</p>
          <span class="tiny">Simulation model estimate (teaching mode)</span>
        </div>
        <div class="row" style="justify-content:space-between; margin-top:8px;">
          <strong>0-3 MONTH NET GAP: ${formatCurrency(gap03.netGap)}</strong>
          <span>LCR ${snapshot.metrics.lcr.toFixed(1)}% • NSFR ${snapshot.metrics.nsfr.toFixed(1)}%</span>
        </div>
        <div style="height:14px;border-radius:999px;background:rgba(255,255,255,0.12);overflow:hidden;margin-top:8px;">
          <div style="height:100%;width:${Math.min(100, Math.abs(Number(gap03.netGap || 0)) / 60_000_000)}%;background:linear-gradient(90deg,#ff8f8f,#ff3d5b);"></div>
        </div>
      </article>
    `;
  }

  if (phase === 'phase2') {
    const depositorTop = (snapshot.leaderboard || []).filter((row) => row.role === 'depositor').slice(0, 3);
    const latestAlert = (snapshot.eventFeed || []).find((item) => item.type === 'alert') || snapshot.eventFeed?.[0] || null;
    const gap03 = (snapshot.metrics.gapTable || []).find((row) => row.bucket === '0-3m') || { netGap: 0 };
    const shortTermPct = Number(snapshot.metrics.fundingConcentrationPct || 0);
    const longTermPct = Math.max(0, 100 - shortTermPct);
    const repoRate = Number(snapshot.metrics.liborPct || 0) + 0.08;
    const liveTicker = (snapshot.eventFeed || [])
      .slice(0, 4)
      .map((item) => String(item.text || '').toUpperCase())
      .filter(Boolean)
      .join('  *  ');

    return `
      <section class="panel board-card phase2-monitor">
        <div class="phase2-head">
          <p class="kicker" style="margin:0;">Granite Bank PLC | Market Monitor: Phase 2</p>
          <span class="badge ${snapshot.metrics.scenario === 'SEVERE STRESS' ? 'red' : 'yellow'}">${escapeHtml(snapshot.metrics.scenario)}</span>
        </div>

        <div class="phase2-top-grid">
          <article class="phase2-card">
            <p class="kicker">Retail Hub</p>
            <p style="margin:4px 0 0;"><strong>Top Yields</strong></p>
            <p class="tiny" style="margin:6px 0 0;">
              1. ${escapeHtml(depositorTop[0]?.displayName || '—')}<br />
              2. ${escapeHtml(depositorTop[1]?.displayName || '—')}<br />
              3. ${escapeHtml(depositorTop[2]?.displayName || '—')}
            </p>
            <div class="separator"></div>
            <p class="tiny" style="margin:0;">Active Penalty: <strong>Early Exit -40%</strong></p>
          </article>

          <article class="phase2-card">
            <p class="kicker">Live News</p>
            <div class="phase2-news-box">
              <p class="tiny" style="margin:0; opacity:0.9;">Market Wire</p>
              <p style="margin:6px 0 0;"><strong>${escapeHtml((latestAlert?.text || 'No breaking alert yet.').slice(0, 96))}</strong></p>
            </div>
          </article>

          <article class="phase2-card">
            <p class="kicker">Institutional</p>
            <p style="margin:4px 0 0;">Funding Spread</p>
            <p class="tiny" style="margin:6px 0 0;">LIBOR: <strong>${snapshot.metrics.liborPct.toFixed(2)}%</strong> ▲</p>
            <p class="tiny" style="margin:2px 0 0;">Repo: <strong>${repoRate.toFixed(2)}%</strong> ▲</p>
            <div class="separator"></div>
            <p class="tiny" style="margin:0;">Strategy: Short-term <strong>${shortTermPct.toFixed(0)}%</strong> • Long-term <strong>${longTermPct.toFixed(0)}%</strong></p>
          </article>
        </div>

        <div class="phase2-strip">
          <p class="kicker" style="margin:0;">Sensitivity Alerts</p>
          <div class="phase2-alert-line">
            <span>US Subprime Contagion: <strong>${snapshot.metrics.scenario === 'BASE CASE' ? 'LOW IMPACT' : snapshot.metrics.scenario === 'MODERATE STRESS' ? 'MODERATE IMPACT' : 'SEVERE IMPACT'}</strong></span>
            <span>Interbank Liquidity: <strong>${snapshot.metrics.assumptions.fundingCostStable ? 'STABLE' : 'TIGHTENING'}</strong></span>
            <span>Counterparty Risk: <strong>${snapshot.metrics.assumptions.depositStability ? 'MONITORING' : 'ELEVATED'}</strong></span>
          </div>
        </div>

        <div class="phase2-strip phase2-risk-strip">
          <div class="row" style="justify-content:space-between;">
            <p class="kicker" style="margin:0;">Internal Risk Metrics</p>
            <span class="tiny">Model estimate</span>
          </div>
          <div class="row" style="justify-content:space-between; margin-top:6px;">
            <strong>0-3 MONTH NET GAP: ${formatCurrency(gap03.netGap)}</strong>
            <span>LCR ${snapshot.metrics.lcr.toFixed(1)}% (Req 100%) • Survival ${snapshot.metrics.survivalHours}h</span>
          </div>
          <div style="height:14px;border-radius:999px;background:rgba(255,255,255,0.12);overflow:hidden;margin-top:8px;">
            <div style="height:100%;width:${Math.min(100, Math.abs(Number(gap03.netGap || 0)) / 60_000_000)}%;background:linear-gradient(90deg,#ff8f8f,#ff3d5b);"></div>
          </div>
        </div>

        <div class="phase2-ticker">
          <strong>TICKER:</strong> ${escapeHtml(liveTicker || 'PHASE 2 LIVE. WAITING FOR NEW FLOW UPDATES.')}
        </div>
      </section>
      <div class="phase-panels">
        <article class="panel board-card">
          <p class="kicker">Sensitivity Analysis Matrix</p>
          <table class="table">
            <thead><tr><th>Variable</th><th>Base</th><th>Current</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td>LIBOR</td><td>5.25%</td><td>${snapshot.metrics.liborPct.toFixed(2)}%</td><td>${snapshot.metrics.assumptions.fundingCostStable ? 'Stable' : 'Broken'}</td></tr>
              <tr><td>Prepayment Rate</td><td>12%</td><td>${snapshot.metrics.assumptions.prepaymentRatePct}%</td><td>${snapshot.metrics.assumptions.prepaymentRatePct <= 3 ? 'Broken' : 'Normal'}</td></tr>
              <tr><td>Deposit Stability</td><td>Stable</td><td>${snapshot.metrics.assumptions.depositStability ? 'Stable' : 'Unstable'}</td><td>${snapshot.metrics.assumptions.depositStability ? 'Normal' : 'Broken'}</td></tr>
              <tr><td>Contractual Maturity</td><td>Reference</td><td>${snapshot.metrics.contractualMaturityPct.toFixed(1)}%</td><td>Tracked</td></tr>
              <tr><td>Behavioral Maturity</td><td>Reference</td><td>${snapshot.metrics.behavioralMaturityPct.toFixed(1)}%</td><td>Diverging</td></tr>
            </tbody>
          </table>
        </article>
      </div>
    `;
  }

  if (phase === 'phase3') {
    const pendingRetail = (snapshot.players || [])
      .filter((p) => p.role === 'depositor' && !p.withdrew && Number(p.phase3QueuePosition || 0) > 0)
      .sort((a, b) => Number(a.phase3QueuePosition || 999999) - Number(b.phase3QueuePosition || 999999))
      .slice(0, 3);
    const latestCritical = (snapshot.eventFeed || []).find((item) => item.type === 'critical') || snapshot.eventFeed?.[0] || null;
    const gap03 = (snapshot.metrics.gapTable || []).find((row) => row.bucket === '0-3m') || { netGap: 0 };
    const wholesaleRefusals = Number(snapshot.metrics.wholesaleRefusals || 0);
    const wholesaleTotal = Number(snapshot.counts.wholesale || 0);
    const refusalRate = wholesaleTotal ? (wholesaleRefusals / wholesaleTotal) * 100 : 0;
    const panic = Number(snapshot.metrics.panicMeter || 0);
    const counterpartyStatus = refusalRate >= 45 || panic >= 60 ? 'COLLAPSED' : refusalRate >= 20 || panic >= 40 ? 'WEAKENED' : 'FRAGILE';
    const creditStatus =
      snapshot.metrics.lcr < 25 ? 'DOWNGRADED TO CCC' : snapshot.metrics.lcr < 50 ? 'DOWNGRADED TO B' : 'UNDER WATCH';
    const rolloverStatus = refusalRate >= 50 ? 'FAILED' : refusalRate >= 20 ? 'PARTIAL FAILURE' : 'UNDER PRESSURE';
    const marketStatus = refusalRate >= 30 || panic >= 55 ? 'FROZEN' : 'STRESSED';
    const repoQuote = refusalRate >= 30 || panic >= 55 ? 'NO QUOTE' : `${(snapshot.metrics.liborPct + 1.2).toFixed(2)}%`;
    const queueEtaMax = pendingRetail.length
      ? Math.max(...pendingRetail.map((p) => Number(p.phase3QueueEtaHours || 0)))
      : Math.max(6, Number(snapshot.metrics.survivalHours || 0));
    const ticker = (snapshot.eventFeed || [])
      .slice(0, 4)
      .map((item) => String(item.text || '').toUpperCase())
      .filter(Boolean)
      .join('  *  ');
    const buffer = Number(snapshot.metrics.liquidityBuffer || 0);
    const bufferPct = Math.max(0, Math.min(100, (buffer / 1_100_000_000) * 100));

    return `
      <section class="panel board-card phase3-monitor">
        <div class="phase2-head">
          <p class="kicker" style="margin:0;">Granite Bank PLC | System Halt: Phase 3</p>
          <span class="badge red">PANIC</span>
        </div>

        <div class="phase2-top-grid">
          <article class="phase2-card">
            <p class="kicker">Retail Run</p>
            <p style="margin:4px 0 0;"><strong>Withdrawal Queue</strong></p>
            <p class="tiny" style="margin:6px 0 0;">
              1. Pos #${pendingRetail[0]?.phase3QueuePosition || '—'} (${pendingRetail[0] ? 'Pending' : '—'})<br />
              2. Pos #${pendingRetail[1]?.phase3QueuePosition || '—'} (${pendingRetail[1] ? 'Pending' : '—'})<br />
              3. Pos #${pendingRetail[2]?.phase3QueuePosition || '—'} (${pendingRetail[2] ? 'Pending' : '—'})
            </p>
            <div class="separator"></div>
            <p class="tiny" style="margin:0;">Exit Penalty: <strong>Locked (System Busy)</strong></p>
          </article>

          <article class="phase2-card">
            <p class="kicker">Breaking</p>
            <div class="phase2-news-box">
              <p class="tiny" style="margin:0; opacity:0.9;">Emergency Wire</p>
              <p style="margin:6px 0 0;"><strong>${escapeHtml((latestCritical?.text || 'Emergency funding talks under pressure.').slice(0, 96))}</strong></p>
            </div>
          </article>

          <article class="phase2-card">
            <p class="kicker">Wholesale</p>
            <p style="margin:4px 0 0;">Funding Status</p>
            <p class="tiny" style="margin:6px 0 0;">Market: <strong>${marketStatus}</strong></p>
            <p class="tiny" style="margin:2px 0 0;">LIBOR: <strong>${repoQuote}</strong></p>
            <div class="separator"></div>
            <p class="tiny" style="margin:0;">Action: <strong>RECALL FUNDS</strong> (${wholesaleRefusals}/${wholesaleTotal})</p>
          </article>
        </div>

        <div class="phase2-strip">
          <p class="kicker" style="margin:0;">Contagion Alerts</p>
          <div class="phase2-alert-line">
            <span>Counterparty Confidence: <strong>${counterpartyStatus}</strong></span>
            <span>Credit Rating: <strong>${creditStatus}</strong></span>
            <span>Wholesale Rollover: <strong>${rolloverStatus}</strong></span>
          </div>
        </div>

        <div class="phase2-strip phase2-risk-strip">
          <div class="row" style="justify-content:space-between;">
            <p class="kicker" style="margin:0;">Liquidity Depletion (The Truth)</p>
            <span class="tiny">Live stress state</span>
          </div>
          <div class="row" style="justify-content:space-between; margin-top:6px;">
            <strong>Cash Buffer: ${formatCurrency(buffer)}</strong>
            <span>${buffer <= 180_000_000 ? 'EVAPORATED' : buffer <= 380_000_000 ? 'CRITICAL' : 'DEPLETING'}</span>
          </div>
          <div style="height:14px;border-radius:999px;background:rgba(255,255,255,0.12);overflow:hidden;margin-top:8px;">
            <div style="height:100%;width:${bufferPct.toFixed(2)}%;background:linear-gradient(90deg,#ff8f8f,#ff3d5b);"></div>
          </div>
          <div class="row" style="justify-content:space-between; margin-top:8px;">
            <span>Net Gap: <strong>${formatCurrency(gap03.netGap)}</strong></span>
            <span>Withdrawal Wait: <strong>${queueEtaMax.toFixed(1)}+ hours</strong></span>
          </div>
        </div>

        <div class="phase2-ticker">
          <strong>TICKER:</strong> ${escapeHtml(ticker || 'CHANCELLOR REFUSES COMMENT * BANK OF ENGLAND MONITORING * PANIC')}
        </div>
      </section>
      <div class="phase-panels">
        <article class="panel board-card">
          <p class="kicker">Funding + Market Liquidity Technical View</p>
          <table class="table">
            <tbody>
              <tr><th>Wholesale refusal rate</th><td>${refusalRate.toFixed(1)}%</td></tr>
              <tr><th>Bid-offer spread</th><td>${snapshot.metrics.assetLiquidity.bidOfferSpreadPct.toFixed(2)}%</td></tr>
              <tr><th>Market depth</th><td>${escapeHtml(snapshot.metrics.assetLiquidity.marketDepth)}</td></tr>
              <tr><th>Immediacy</th><td>${escapeHtml(snapshot.metrics.assetLiquidity.immediacy)}</td></tr>
              <tr><th>Resilience</th><td>${escapeHtml(snapshot.metrics.assetLiquidity.resilience)}</td></tr>
            </tbody>
          </table>
        </article>
      </div>
    `;
  }

  if (phase === 'phase4' || phase === 'end') {
    const gap03 = (snapshot.metrics.gapTable || []).find((row) => row.bucket === '0-3m') || { netGap: 0 };
    const retailReport = snapshot.metrics.phase4RetailReport || {
      totalDepositors: 0,
      fullyProtected: 0,
      sufferedHaircut: 0,
      lostOver10k: 0,
    };
    const wholesaleReport = snapshot.metrics.phase4WholesaleReport || {
      totalWholesale: 0,
      refusalRatePct: 0,
      liquidityDrained: 0,
    };
    const collapsed = snapshot.session.bankStatus === 'COLLAPSED';
    const latestCritical = (snapshot.eventFeed || []).find((item) => item.type === 'critical') || snapshot.eventFeed?.[0] || null;
    const depositorHaircutPct = retailReport.totalDepositors
      ? (Number(retailReport.sufferedHaircut || 0) / Number(retailReport.totalDepositors || 1)) * 100
      : 0;
    const ticker = (snapshot.eventFeed || [])
      .slice(0, 4)
      .map((item) => String(item.text || '').toUpperCase())
      .filter(Boolean)
      .join('  *  ');

    return `
      <section class="panel board-card phase3-monitor">
        <div class="phase2-head">
          <p class="kicker" style="margin:0;">Granite Bank PLC | ${collapsed ? 'Nationalized by HM Treasury' : 'Public Backstop Activated'}</p>
          <span class="badge ${collapsed ? 'red' : 'yellow'}">${collapsed ? 'FAILED' : 'STABILIZED'}</span>
        </div>

        <div class="phase2-top-grid">
          <article class="phase2-card">
            <p class="kicker">Govt Takeover</p>
            <p class="tiny" style="margin:6px 0 0;">Retail Impact</p>
            <p class="tiny" style="margin:4px 0 0;">- Deposits: <strong>${collapsed ? 'FROZEN' : 'PARTIALLY GUARANTEED'}</strong></p>
            <p class="tiny" style="margin:2px 0 0;">- Interest: <strong>${collapsed ? 'FORFEITED / TRUNCATED' : 'RESET UNDER RESOLUTION'}</strong></p>
            <p class="tiny" style="margin:2px 0 0;">- Access: <strong>${collapsed ? '6 MONTHS+' : 'STAGED RELEASE'}</strong></p>
            <div class="separator"></div>
            <p class="tiny" style="margin:0;">Final Verdict: <strong>${collapsed ? 'BANKRUPT / FAILED' : 'RESCUED / RESTRUCTURED'}</strong></p>
          </article>

          <article class="phase2-card">
            <p class="kicker">Final News</p>
            <div class="phase2-news-box">
              <p class="tiny" style="margin:0; opacity:0.9;">Financial Wire</p>
              <p style="margin:6px 0 0;"><strong>${escapeHtml((latestCritical?.text || 'Resolution process in effect.').slice(0, 96))}</strong></p>
            </div>
          </article>

          <article class="phase2-card">
            <p class="kicker">Liquidation</p>
            <p class="tiny" style="margin:6px 0 0;">Lender Losses</p>
            <p class="tiny" style="margin:4px 0 0;">- Funding drained: <strong>${formatCurrency(wholesaleReport.liquidityDrained || 0)}</strong></p>
            <p class="tiny" style="margin:2px 0 0;">- Refusal rate: <strong>${Number(wholesaleReport.refusalRatePct || 0).toFixed(1)}%</strong></p>
            <div class="separator"></div>
            <p class="tiny" style="margin:0;">Rating: <strong>${collapsed ? 'D - DEFAULT' : 'B - SUPPORTED'}</strong></p>
          </article>
        </div>

        <div class="phase2-strip">
          <p class="kicker" style="margin:0;">Post-Mortem Analysis</p>
          <div class="phase2-alert-line">
            <span>Primary Cause: <strong>Asset/Liability Mismatch</strong></span>
            <span>Funding Gap: <strong>${formatCurrency(Math.abs(Number(gap03.netGap || 0)))}</strong></span>
            <span>Regulatory Breach: <strong>${snapshot.metrics.lcr < 100 || snapshot.metrics.nsfr < 100 ? 'YES' : 'NO'}</strong></span>
          </div>
        </div>

        <div class="phase2-strip phase2-risk-strip">
          <p class="kicker" style="margin:0;">Final Scoreboard</p>
          <div class="row" style="justify-content:space-between; margin-top:6px;">
            <span>Depositor Loss Impact: <strong>${depositorHaircutPct.toFixed(1)}% had haircut</strong></span>
            <span>Wholesale Stress: <strong>${Number(wholesaleReport.refusalRatePct || 0).toFixed(1)}% refused rollover</strong></span>
          </div>
        </div>

        <div class="phase2-ticker">
          <strong>TICKER:</strong> ${escapeHtml(
            ticker || 'GRANITE BANK REMOVED FROM MAJOR INDICES * RESOLUTION AUTHORITY REVIEW * POST-MORTEM UNDERWAY'
          )}
        </div>
      </section>
    `;
  }

  return `<article class="panel board-card"><p class="muted">Waiting for phase to start. Phase data will activate once the game master begins Phase 1.</p></article>`;
}

function renderProjectorScreen(snapshot) {
  const isLobby = snapshot.session.phase === 'lobby';
  const lcrDisplay = isLobby ? 'N/A' : `${snapshot.metrics.lcr.toFixed(1)}%`;
  const nsfrDisplay = isLobby ? 'N/A' : `${snapshot.metrics.nsfr.toFixed(1)}%`;
  const survivalDisplay = isLobby ? 'N/A' : `${snapshot.metrics.survivalHours}h`;
  const bufferDisplay = isLobby ? 'N/A' : formatCurrency(snapshot.metrics.liquidityBuffer);
  const projectorTitleByPhase = {
    lobby: 'Simulation Control Board',
    phase1: 'Phase 1: Build The Funding Structure',
    phase2: 'Phase 2: Assumptions Under Stress',
    phase3: 'Phase 3: Liquidity Freeze',
    phase4: 'Phase 4: Resolution / Failure',
    end: 'Simulation End State',
  };
  const projectorTitle = projectorTitleByPhase[snapshot.session.phase] || 'Simulation Control Board';

  app.innerHTML = `
    <div class="desktop-wrap">
      <section class="panel dashboard-head">
        <div>
          <p class="dashboard-phase">Granite Bank | ${escapeHtml(snapshot.session.phase.toUpperCase())}</p>
          <h1 class="dashboard-title">${escapeHtml(projectorTitle)}</h1>
          <p class="tiny">Presented by Group 3</p>
          <p class="tiny">Session ${escapeHtml(snapshot.session.code)}</p>
        </div>
        <div class="top-metrics">
          <div class="metric red"><small>LCR</small><strong>${lcrDisplay}</strong></div>
          <div class="metric red"><small>NSFR</small><strong>${nsfrDisplay}</strong></div>
          <div class="metric ${!isLobby && snapshot.metrics.survivalHours < 48 ? 'red' : 'green'}"><small>Survival Horizon</small><strong>${survivalDisplay}</strong></div>
          <div class="metric metric-buffer"><small>Buffer</small><strong title="${escapeHtml(bufferDisplay)}">${bufferDisplay}</strong></div>
        </div>
      </section>

      ${renderPhaseSpecificProjector(snapshot)}

      <section class="board-grid">
        <article class="panel board-card">
          <div class="row" style="justify-content:space-between;">
            <p class="kicker" style="margin:0;">Leaderboard</p>
            <span class="warning-chip">${snapshot.session.revealNames ? 'NAMES REVEALED' : 'ANONYMOUS LIVE'}</span>
          </div>
          <table class="table">
            <thead><tr><th>#</th><th>Player</th><th>Role</th><th>Score</th><th>Label</th></tr></thead>
            <tbody>
              ${snapshot.leaderboard
                .slice(0, 10)
                .map(
                  (row, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${escapeHtml(row.displayName)}</td>
                  <td>${escapeHtml(row.role)}</td>
                  <td>${row.score}</td>
                  <td>${escapeHtml(row.label)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </article>

        <article class="panel board-card">
          <p class="kicker">Live Event Feed</p>
          <div class="feed-list">
            ${snapshot.eventFeed
              .map(
                (item) => `
              <div class="feed-item ${escapeHtml(item.type || 'info')}">
                <div class="tiny">${shortDate(item.at)}</div>
                <div>${escapeHtml(item.text)}</div>
              </div>
            `
              )
              .join('')}
          </div>
        </article>
      </section>
    </div>
  `;
}

async function pullProjectorSnapshot() {
  try {
    const snapshot = await request('/api/state');
    renderProjectorScreen(snapshot);
  } catch (error) {
    app.innerHTML = `<div class="screen"><div class="panel hero-card"><h2>Projector unavailable</h2><p>${escapeHtml(error.message)}</p></div></div>`;
  }
}

async function renderProjector() {
  clearPoll();
  await pullProjectorSnapshot();
  startPoll(pullProjectorSnapshot, 2000);
}

function gmPhaseButtons(activePhase) {
  const phases = ['lobby', 'phase1', 'phase2', 'phase3', 'phase4', 'end'];
  return phases
    .map(
      (phase) =>
        `<button class="${phase === activePhase ? 'btn-primary' : 'btn-secondary'}" data-gm-phase="${phase}">${phase.toUpperCase()}</button>`
    )
    .join('');
}

function renderGmScreen(snapshot) {
  const phaseLabels = {
    lobby: 'Start Game',
    phase1: 'Phase 1: The Gold Rush',
    phase2: 'Phase 2: The Trap',
    phase3: 'Phase 3: The Freeze',
    phase4: 'Phase 4: Final Call',
    end: 'End Simulation',
  };
  const phaseOrder = ['lobby', 'phase1', 'phase2', 'phase3', 'phase4', 'end'];
  const currentPhaseIdx = phaseOrder.indexOf(snapshot.session.phase);
  const nextPhase = phaseOrder[currentPhaseIdx + 1] || null;
  const gap03 = snapshot.metrics.gapTable.find((row) => row.bucket === '0-3m');
  const firedAt = snapshot.session.eventTriggeredAt || {};
  const eventCard = (key, label, effect) => {
    const isFired = snapshot.session.activeEvents.includes(key);
    const when = firedAt[key] ? shortDate(firedAt[key]) : null;
    return `
      <div class="panel" style="padding:12px; margin-top:8px;">
        <p class="kicker" style="margin:0;">${label}</p>
        <p style="margin:6px 0 0;">Status: ${isFired ? `<strong style="color:#9effc8;">Fired ${when || ''}</strong>` : '<strong style="color:#d7d7d7;">Not fired</strong>'}</p>
        <p class="tiny" style="margin-top:4px;">${effect}</p>
        ${
          isFired
            ? ''
            : `<button class="btn-secondary" style="margin-top:8px;" data-gm-event="${key}">Trigger ${label}</button>`
        }
      </div>
    `;
  };

  app.innerHTML = `
    <div class="screen shell-grid">
      <section class="panel hero-card">
        <span class="pill">Game Master Control</span>
        <h1 class="hero-title">${escapeHtml(phaseLabels[snapshot.session.phase] || snapshot.session.phase)}</h1>
        <p class="hero-subtitle">Started ${shortDate(snapshot.session.phaseStartedAt)} • Elapsed ${elapsedSince(snapshot.session.phaseStartedAt)}</p>
      </section>

      <section class="control-grid">
        <article class="panel control-card">
          <p class="kicker">Live Stats</p>
          <div class="stat-grid">
            <div class="stat-card"><span class="stat-label">Depositors</span><div class="stat-value">${snapshot.counts.depositor} (${snapshot.metrics.depositorWithdrawals} out)</div></div>
            <div class="stat-card"><span class="stat-label">Wholesale</span><div class="stat-value">${snapshot.counts.wholesale} (${snapshot.metrics.phase2Wholesale?.liveCount || 0} live)</div></div>
            <div class="stat-card"><span class="stat-label">Liquid buffer</span><div class="stat-value">${formatCurrency(snapshot.metrics.liquidityBuffer)}</div></div>
            <div class="stat-card"><span class="stat-label">Depositor confidence</span><div class="stat-value">${(snapshot.metrics.phase2Depositor?.confidencePct || 0).toFixed(0)}%</div></div>
            <div class="stat-card"><span class="stat-label">Wholesale rollover</span><div class="stat-value">${(snapshot.metrics.phase2Wholesale?.rolloverRatePct || 0).toFixed(1)}%</div></div>
            <div class="stat-card"><span class="stat-label">LCR / NSFR</span><div class="stat-value">${snapshot.metrics.lcr.toFixed(1)}% / ${snapshot.metrics.nsfr.toFixed(1)}%</div></div>
            <div class="stat-card"><span class="stat-label">0-3m gap</span><div class="stat-value">${formatCurrency(gap03 ? gap03.netGap : 0)}</div></div>
            <div class="stat-card"><span class="stat-label">Cumulative gap</span><div class="stat-value">${formatCurrency((snapshot.metrics.cumulativeGap || []).slice(-1)[0]?.value || 0)}</div></div>
            <div class="stat-card"><span class="stat-label">P2 Upgraded</span><div class="stat-value">${snapshot.metrics.phase2Depositor?.upgraded || 0}</div></div>
            <div class="stat-card"><span class="stat-label">P2 Added Money</span><div class="stat-value">${snapshot.metrics.phase2Depositor?.addedMore || 0}</div></div>
            <div class="stat-card"><span class="stat-label">P2 Early Exits</span><div class="stat-value">${snapshot.metrics.phase2Depositor?.exited || 0}</div></div>
            <div class="stat-card"><span class="stat-label">P2 Hedges</span><div class="stat-value">${snapshot.metrics.phase2Depositor?.hedged || 0}</div></div>
          </div>

          <div class="separator"></div>
          <p class="kicker">Event Triggers</p>
          ${eventCard('LIBOR_RISE', 'Event 1: LIBOR Rising', 'Funding costs rise, sensitivity matrix updates.')}
          ${eventCard('PREPAY_SLOW', 'Event 2: Prepayments Slow', '0-3m inflows drop and the short bucket worsens.')}
          ${eventCard('COMPETITOR_15', 'Event 3: Competitor Bond', 'Behavioral maturity diverges from contractual maturity.')}
          <div class="separator"></div>
          <p class="kicker">Phase Controls</p>
          <div class="panel" style="padding:12px;">
            ${phaseOrder
              .map((phase, idx) => {
                const status = idx < currentPhaseIdx ? 'Completed' : idx === currentPhaseIdx ? 'Active now' : 'Pending';
                return `<p style="margin:0 0 8px;"><strong>${escapeHtml(phaseLabels[phase])}</strong> • ${status}</p>`;
              })
              .join('')}
            ${
              nextPhase
                ? `<button class="btn-primary" data-gm-phase="${nextPhase}">Advance to ${escapeHtml(phaseLabels[nextPhase])}</button>`
                : ''
            }
          </div>
        </article>

        <article class="panel control-card">
          <p class="kicker">Broadcast + Safety</p>
          <label class="tiny">Push Notification to all screens</label>
          <textarea id="gm-message" placeholder="Type a short announcement..."></textarea>
          <div class="row" style="margin-top:8px;">
            <button id="gm-send" class="btn-primary">Send Broadcast</button>
            <button class="btn-danger" data-gm-event="BBC_LEAK">Force Crisis (BBC Leak)</button>
            <button id="gm-reset" class="btn-danger">Reset Session</button>
            <a class="button btn-secondary" href="#/projector">Open Projector</a>
            <a class="button btn-secondary" href="#/hub">Open Lobby QR</a>
          </div>

          <div class="separator"></div>
          <p class="kicker">BoE Decision</p>
          <div class="row">
            <button class="btn-good" data-gm-boe="rescue">Approve Rescue</button>
            <button class="btn-danger" data-gm-boe="collapse">Force Collapse</button>
          </div>

          <div class="separator"></div>
          <p class="kicker">Latest Events</p>
          <div class="feed-list" style="max-height:360px;">
            ${snapshot.eventFeed
              .slice(0, 12)
              .map(
                (event) => `
                <div class="feed-item ${escapeHtml(event.type || 'info')}">
                  <div class="tiny">${shortDate(event.at)}</div>
                  <div>${escapeHtml(event.text)}</div>
                </div>
              `
              )
              .join('')}
          </div>
          ${renderFlash()}
        </article>
      </section>
    </div>
  `;

  document.querySelectorAll('[data-gm-phase]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const targetPhase = button.dataset.gmPhase;
        if (snapshot.session.phase === 'phase2' && targetPhase === 'phase3') {
          const ok = window.confirm(
            'Advance to Phase 3? This locks Phase 2 decisions and activates dual crisis view. This cannot be undone.'
          );
          if (!ok) return;
        }
        clearFlash();
        await request('/api/gm/phase', { method: 'POST', body: { phase: targetPhase } });
        setFlash('success', `Phase switched to ${targetPhase}.`);
        await pullGmSnapshot();
      } catch (error) {
        setFlash('error', error.message);
        await pullGmSnapshot();
      }
    });
  });

  document.querySelectorAll('[data-gm-event]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        clearFlash();
        await request('/api/gm/event', { method: 'POST', body: { eventKey: button.dataset.gmEvent } });
        setFlash('success', `${button.dataset.gmEvent} triggered.`);
        await pullGmSnapshot();
      } catch (error) {
        setFlash('error', error.message);
        await pullGmSnapshot();
      }
    });
  });

  document.querySelectorAll('[data-gm-boe]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        clearFlash();
        await request('/api/gm/boe', { method: 'POST', body: { decision: button.dataset.gmBoe } });
        setFlash('success', `BoE decision: ${button.dataset.gmBoe}.`);
        await pullGmSnapshot();
      } catch (error) {
        setFlash('error', error.message);
        await pullGmSnapshot();
      }
    });
  });

  document.getElementById('gm-send')?.addEventListener('click', async () => {
    try {
      const message = document.getElementById('gm-message').value.trim();
      await request('/api/gm/notify', { method: 'POST', body: { message } });
      setFlash('success', 'Broadcast pushed to live feed.');
      await pullGmSnapshot();
    } catch (error) {
      setFlash('error', error.message);
      await pullGmSnapshot();
    }
  });

  document.getElementById('gm-reset')?.addEventListener('click', async () => {
    const confirmed = window.confirm('Reset the entire session state?');
    if (!confirmed) return;
    try {
      await request('/api/session/reset', { method: 'POST' });
      setFlash('success', 'Session reset complete.');
      await pullGmSnapshot();
    } catch (error) {
      setFlash('error', error.message);
      await pullGmSnapshot();
    }
  });
}

async function pullGmSnapshot() {
  try {
    const snapshot = await request('/api/state');
    renderGmScreen(snapshot);
  } catch (error) {
    app.innerHTML = `<div class="screen"><div class="panel hero-card"><h2>GM console unavailable</h2><p>${escapeHtml(error.message)}</p></div></div>`;
  }
}

async function renderGm() {
  clearPoll();
  await pullGmSnapshot();
  startPoll(pullGmSnapshot, 2000);
}

async function route() {
  const { route } = parseHashRoute();
  if (ui.routeCache === route) {
    return;
  }
  ui.routeCache = route;
  clearPoll();

  if (route === 'hub') {
    await renderHub();
    return;
  }
  if (route === 'join') {
    await renderJoin();
    return;
  }
  if (route === 'player') {
    await renderPlayer();
    return;
  }
  if (route === 'projector') {
    await renderProjector();
    return;
  }
  if (route === 'gm') {
    await renderGm();
    return;
  }

  goto('hub');
}

if (!location.hash) {
  if (storage.resumeToken && storage.playerId) {
    location.hash = '#/player';
  } else {
    location.hash = '#/hub';
  }
}

window.addEventListener('hashchange', route);
route();
