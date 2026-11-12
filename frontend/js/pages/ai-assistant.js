// AI assistant (offline RAG chatbot)
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// AI ASSISTANT (offline RAG chatbot over live e-Delphyn data)
// ═══════════════════════════════════════════════════════
let _aiInitialized = false;
let _aiHistory = [];  // [{role:'user'|'assistant', content:'...'}, ...] — sent back for follow-up context

function initAI() {
  if (_aiInitialized) { document.getElementById('aiChatInput').focus(); return; }
  _aiInitialized = true;
  addAIMessage('Ask me anything about donors, requests, transfusions, or wasted units — I answer from your live e-Delphyn data, fully offline (no cloud AI).', 'bot');
  document.getElementById('aiChatInput').focus();
}

function addAIMessage(text, cls) {
  const box = document.getElementById('aiChatMessages');
  const div = document.createElement('div');
  div.className = 'ai-msg ' + cls;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// "Live e-Delphyn data · 14:32" or a warning when the bot fell back to the
// last saved snapshot because node-backend / e-Delphyn wasn't reachable.
function aiDataNote(status) {
  if (!status?.data_as_of) return '';
  const t = new Date(status.data_as_of);
  const when = isNaN(t) ? status.data_as_of
    : t.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  return status.source === 'live'
    ? `Live e-Delphyn data · ${when}`
    : `⚠ Live data unavailable — answered from saved snapshot (${when})`;
}

async function sendAIMessage(evt) {
  evt.preventDefault();
  const input = document.getElementById('aiChatInput');
  const question = input.value.trim();
  if (!question) return false;
  addAIMessage(question, 'user');
  input.value = '';
  const sendBtn = document.getElementById('aiChatSend');
  sendBtn.disabled = true;
  const loadingEl = addAIMessage('Thinking… (can take up to a minute on this laptop)', 'bot loading');

  try {
    const res  = await apiFetch(`${API}/api/rag-chat`, { method: 'POST', body: { question, history: _aiHistory } });
    const data = res ? await res.json() : null;
    loadingEl.classList.remove('loading');
    if (data?.answer) {
      loadingEl.textContent = data.answer;
      const note = aiDataNote(data.data);
      if (note) {
        const meta = document.createElement('div');
        meta.className = 'ai-msg-meta';
        meta.style.cssText = 'font-size:11px;opacity:.65;margin-top:6px';
        meta.textContent = note;
        loadingEl.appendChild(meta);
      }
      _aiHistory.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
      _aiHistory = _aiHistory.slice(-6);
    } else {
      loadingEl.textContent = data?.error || 'No response.';
    }
  } catch (err) {
    loadingEl.classList.remove('loading');
    loadingEl.textContent = 'Error: could not reach the AI assistant service.';
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
  return false;
}
