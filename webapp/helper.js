/**
 * WebSocket client for the SlabScannerHelper (localhost:7878).
 * Handles connection lifecycle, reconnection, OCR requests, and scanner control.
 */

const SlabHelper = (() => {
  const WS_URL = 'ws://127.0.0.1:7878';
  const RECONNECT_DELAY = 3000;
  const OCR_TIMEOUT = 10000;

  let ws = null;
  let connected = false;
  let capabilities = { scan: false, ocr: false };
  let reconnectTimer = null;
  let pendingOCR = new Map(); // id -> { resolve, timer }
  let onStatusChange = null;
  let onScanMessage = null;

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    _updateStatus('connecting');

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.log('[helper] WebSocket constructor failed:', e.message);
      _updateStatus('disconnected');
      _scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[helper] WebSocket connected');
      ws.send(JSON.stringify({ type: 'hello', version: '1.0' }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'hello') {
        connected = true;
        capabilities = msg.capabilities || { scan: false, ocr: false };
        console.log('[helper] Hello received, capabilities:', capabilities);
        _updateStatus('connected');
        return;
      }

      if (msg.type === 'ocr_result') {
        const pending = pendingOCR.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingOCR.delete(msg.id);
          pending.resolve({ text: msg.text, confidence: msg.confidence });
        }
        return;
      }

      // Scanner messages forwarded to callback
      if (msg.type && msg.type.startsWith('scan_')) {
        if (onScanMessage) onScanMessage(msg);
        return;
      }
    };

    ws.onclose = () => {
      console.log('[helper] WebSocket closed');
      connected = false;
      capabilities = { scan: false, ocr: false };
      _updateStatus('disconnected');
      // Reject all pending OCR
      for (const [id, pending] of pendingOCR) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      pendingOCR.clear();
      _scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  function _scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY);
  }

  function _updateStatus(state) {
    if (onStatusChange) onStatusChange(state, capabilities);
  }

  function _genId() {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  }

  /** Send an image (canvas) for Apple Vision OCR. Returns { text, confidence } or null. */
  function ocr(canvas) {
    return new Promise((resolve) => {
      if (!connected || !capabilities.ocr || !ws || ws.readyState !== WebSocket.OPEN) {
        resolve(null);
        return;
      }

      const id = _genId();
      const dataURL = canvas.toDataURL('image/png');
      const base64 = dataURL.split(',')[1];

      const timer = setTimeout(() => {
        pendingOCR.delete(id);
        console.warn('[helper] OCR timeout for', id);
        resolve(null);
      }, OCR_TIMEOUT);

      pendingOCR.set(id, { resolve, timer });

      ws.send(JSON.stringify({
        type: 'ocr',
        id: id,
        image_base64: base64
      }));
    });
  }

  /** Start a scan on the V600. */
  function scanStart(dpi = 300) {
    if (!connected || !capabilities.scan || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({
      type: 'scan_start',
      params: { dpi, color: true }
    }));
    return true;
  }

  /** Cancel an in-progress scan. */
  function scanCancel() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'scan_cancel' }));
  }

  /** Save a file via the helper (to ~/Desktop/<folder>/<filename>). */
  function saveFile(folder, filename, base64) {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({
      type: 'save_file',
      folder,
      filename,
      data: base64
    }));
    return true;
  }

  return {
    connect,
    ocr,
    scanStart,
    scanCancel,
    saveFile,
    get connected() { return connected; },
    get capabilities() { return { ...capabilities }; },
    set onStatusChange(fn) { onStatusChange = fn; },
    set onScanMessage(fn) { onScanMessage = fn; },
  };
})();
