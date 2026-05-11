const PAGE_SIZE = 15;
const DB_NAME = "ItalianExamTrainerWeb";
const DB_VERSION = 2;
const STORAGE_KEY = "ItalianExamTrainerWeb.history.v2";
const PERSISTENT_STORES = ["wordStats", "vocabularySessions", "questionStats", "uiState", "manualWords"];

const app = {
  db: null,
  content: null,
  questions: null,
  manualWords: [],
  wordsByID: new Map(),
  wordsByLevel: new Map(),
  grammarByID: new Map(),
  grammarByLevel: new Map(),
  ui: {
    activeTab: "vocabulary",
    vocabularyLevel: "A1",
    vocabularyMode: "training",
    unmasteredPageIndex: 0,
    grammarDetailID: null,
    examMode: "exam",
    examLevel: "A1",
    wrongSetLevel: null,
    manualLevel: "A1",
  },
  trainingVisible: new Set(),
  unmasteredVisible: new Set(),
  grammarAnswers: new Map(),
  examSession: null,
  wrongSetSession: null,
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    showStatus("加载本地内容...");
    const [content, questions, db] = await Promise.all([
      fetchJSON("data/content.json"),
      fetchJSON("data/questions.json"),
      openDB(),
    ]);
    app.content = content;
    app.questions = questions;
    app.db = db;
    await reconcilePersistentStores();
    app.manualWords = await loadManualWords();
    indexContent(content, app.manualWords);
    app.ui = { ...app.ui, ...(await loadUIState()) };
    bindEvents();
    hydrateLevelSelects();
    await render();
    hideStatus();
  } catch (error) {
    showStatus(`加载失败：${error.message}`);
  }
}

async function fetchJSON(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("wordStats")) db.createObjectStore("wordStats", { keyPath: "wordID" });
      if (!db.objectStoreNames.contains("vocabularySessions")) db.createObjectStore("vocabularySessions", { keyPath: "level" });
      if (!db.objectStoreNames.contains("questionStats")) db.createObjectStore("questionStats", { keyPath: "questionID" });
      if (!db.objectStoreNames.contains("uiState")) db.createObjectStore("uiState", { keyPath: "key" });
      if (!db.objectStoreNames.contains("manualWords")) db.createObjectStore("manualWords", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txStore(name, mode = "readonly") {
  return app.db.transaction(name, mode).objectStore(name);
}

function idbGet(name, key) {
  return new Promise((resolve, reject) => {
    const request = txStore(name).get(key);
    request.onsuccess = () => resolve(request.result || localGet(name, key) || null);
    request.onerror = () => reject(request.error);
  });
}

function idbGetAll(name) {
  return new Promise((resolve, reject) => {
    const request = txStore(name).getAll();
    request.onsuccess = () => {
      const records = request.result || [];
      resolve(records.length ? records : localGetAll(name));
    };
    request.onerror = () => reject(request.error);
  });
}

function idbPut(name, value) {
  return new Promise((resolve, reject) => {
    const request = txStore(name, "readwrite").put(value);
    request.onsuccess = () => {
      localPut(name, value);
      resolve(value);
    };
    request.onerror = () => reject(request.error);
  });
}

function idbDelete(name, key) {
  return new Promise((resolve, reject) => {
    const request = txStore(name, "readwrite").delete(key);
    request.onsuccess = () => {
      localDelete(name, key);
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function idbGetAllDirect(name) {
  return new Promise((resolve, reject) => {
    const request = txStore(name).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function idbPutDirect(name, value) {
  return new Promise((resolve, reject) => {
    const request = txStore(name, "readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

async function reconcilePersistentStores() {
  for (const storeName of PERSISTENT_STORES) {
    const merged = new Map();
    for (const record of localGetAll(storeName)) merged.set(recordKey(storeName, record), record);
    for (const record of await idbGetAllDirect(storeName)) {
      const key = recordKey(storeName, record);
      const current = merged.get(key);
      if (!current || recordTimestamp(record) >= recordTimestamp(current)) merged.set(key, record);
    }
    const records = [...merged.values()];
    localReplaceAll(storeName, records);
    for (const record of records) await idbPutDirect(storeName, record);
  }
}

function readBackup() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBackup(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, stores: {}, ...snapshot }));
  } catch {
    // IndexedDB remains the primary store if the browser blocks localStorage.
  }
}

function localGet(name, key) {
  return readBackup().stores?.[name]?.[key] || null;
}

function localGetAll(name) {
  return Object.values(readBackup().stores?.[name] || {});
}

function localPut(name, value) {
  const snapshot = readBackup();
  snapshot.stores ||= {};
  snapshot.stores[name] ||= {};
  snapshot.stores[name][recordKey(name, value)] = value;
  writeBackup(snapshot);
}

function localDelete(name, key) {
  const snapshot = readBackup();
  if (snapshot.stores?.[name]) delete snapshot.stores[name][key];
  writeBackup(snapshot);
}

function localReplaceAll(name, records) {
  const snapshot = readBackup();
  snapshot.stores ||= {};
  snapshot.stores[name] = {};
  for (const record of records) snapshot.stores[name][recordKey(name, record)] = record;
  writeBackup(snapshot);
}

function recordKey(name, record) {
  if (name === "wordStats") return record.wordID;
  if (name === "vocabularySessions") return record.level;
  if (name === "questionStats") return record.questionID;
  if (name === "uiState") return record.key;
  if (name === "manualWords") return record.id;
  return record.id;
}

function recordTimestamp(record) {
  return record.updatedAt || record.lastRevealedAt || record.lastSeenAt || record.createdAt || 0;
}

function indexContent(content, manualWords = []) {
  app.wordsByID = new Map();
  app.wordsByLevel = new Map();
  app.grammarByID = new Map();
  app.grammarByLevel = new Map();
  for (const level of content.levels) {
    app.wordsByLevel.set(level, []);
    app.grammarByLevel.set(level, []);
  }
  for (const word of [...content.words, ...manualWords]) {
    app.wordsByID.set(word.id, word);
    app.wordsByLevel.get(word.level)?.push(word);
  }
  for (const point of content.grammarPoints) {
    app.grammarByID.set(point.id, point);
    app.grammarByLevel.get(point.level)?.push(point);
  }
}

async function loadUIState() {
  const saved = await idbGet("uiState", "main");
  if (!saved) return {};
  const { key, updatedAt, ...state } = saved;
  return state;
}

async function saveUIState() {
  await idbPut("uiState", { key: "main", ...app.ui, updatedAt: Date.now() });
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", async () => {
      app.ui.activeTab = button.dataset.tab;
      await saveUIState();
      await render();
    });
  });

  document.body.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    await handleAction(action.dataset.action, action.dataset);
  });

  document.body.addEventListener("change", async (event) => {
    if (event.target.id === "vocabulary-level") {
      app.ui.vocabularyLevel = event.target.value;
      app.ui.vocabularyMode = "training";
      app.trainingVisible = new Set();
      await saveUIState();
      await renderVocabulary();
    }
    if (event.target.id === "exam-level") {
      app.ui.examLevel = event.target.value;
      app.examSession = null;
      await saveUIState();
      await renderExam();
    }
    if (event.target.id === "manual-level") {
      app.ui.manualLevel = event.target.value;
      await saveUIState();
    }
  });

  document.querySelector("#manual-word-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addManualWord(new FormData(event.currentTarget));
  });

  document.querySelector("#open-unmastered").addEventListener("click", async () => {
    app.ui.vocabularyMode = "unmastered";
    app.ui.unmasteredPageIndex = 0;
    app.unmasteredVisible = new Set();
    await saveUIState();
    await renderVocabulary();
  });
}

function hydrateLevelSelects() {
  const levelOptions = app.content.levels.map((level) => `<option value="${level}">${level}</option>`).join("");
  document.querySelector("#vocabulary-level").innerHTML = levelOptions;
  document.querySelector("#manual-level").innerHTML = levelOptions;
}

async function render() {
  if (!document.querySelector(`#view-${app.ui.activeTab}`)) app.ui.activeTab = "vocabulary";
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === app.ui.activeTab);
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelector(`#view-${app.ui.activeTab}`).classList.add("active");
  if (app.ui.activeTab === "vocabulary") await renderVocabulary();
  if (app.ui.activeTab === "grammar") await renderGrammar();
  if (app.ui.activeTab === "exam") await renderExam();
  if (app.ui.activeTab === "manual") await renderManual();
}

async function handleAction(action, data) {
  if (action === "speak") speak(data.text);
  if (action === "show-training-word") await revealTrainingWord(data.wordID);
  if (action === "show-unmastered-word") await revealUnmasteredWord(data.wordID);
  if (action === "previous-training") await previousTrainingPage();
  if (action === "next-training") await nextTrainingPage();
  if (action === "complete-cycle") await completeTrainingCycle();
  if (action === "reset-cycle") await resetTrainingCycle();
  if (action === "back-training") {
    app.ui.vocabularyMode = "training";
    await saveUIState();
    await renderVocabulary();
  }
  if (action === "previous-unmastered") await shiftUnmasteredPage(-1);
  if (action === "next-unmastered") await shiftUnmasteredPage(1);
  if (action === "open-grammar") {
    app.ui.grammarDetailID = data.grammarID;
    app.grammarAnswers = new Map();
    await saveUIState();
    await renderGrammar();
  }
  if (action === "back-grammar") {
    app.ui.grammarDetailID = null;
    app.grammarAnswers = new Map();
    await saveUIState();
    await renderGrammar();
  }
  if (action === "answer-grammar") {
    app.grammarAnswers.set(data.questionID, Number(data.answer));
    await renderGrammar();
  }
  if (action === "exam-mode") {
    app.ui.examMode = data.mode;
    app.ui.wrongSetLevel = null;
    app.wrongSetSession = null;
    await saveUIState();
    await renderExam();
  }
  if (action === "start-exam") await startExam();
  if (action === "answer-exam") await answerExam(Number(data.answer));
  if (action === "next-exam") await nextExamQuestion();
  if (action === "open-wrong-set") {
    app.ui.wrongSetLevel = data.level;
    await saveUIState();
    await openWrongSet(data.level);
  }
  if (action === "back-wrong-levels") {
    app.ui.wrongSetLevel = null;
    app.wrongSetSession = null;
    await saveUIState();
    await renderExam();
  }
  if (action === "answer-wrong-set") await answerWrongSet(Number(data.answer));
  if (action === "next-wrong-set") await nextWrongSetQuestion();
  if (action === "delete-manual-word") await deleteManualWord(data.manualID);
}

async function getWordStat(wordID) {
  return (await idbGet("wordStats", wordID)) || {
    wordID,
    meaningRevealCount: 0,
    unmasteredRevealCount: 0,
    lastSeenAt: null,
    lastRevealedAt: null,
  };
}

async function putWordStat(stat) {
  await idbPut("wordStats", stat);
}

async function loadManualWords() {
  return (await idbGetAll("manualWords"))
    .map(normalizeManualWord)
    .filter((word) => word.id && word.level && word.word && word.meaningZh);
}

function normalizeManualWord(word) {
  return {
    id: word.id,
    level: app.content.levels.includes(word.level) ? word.level : "A1",
    word: String(word.word || "").trim(),
    ipa: String(word.ipa || "").trim(),
    meaningZh: String(word.meaningZh || "").trim(),
    examples: Array.isArray(word.examples) ? word.examples.filter((example) => example.it || example.zh) : [],
    source: "manual",
    createdAt: word.createdAt || Date.now(),
    updatedAt: word.updatedAt || word.createdAt || Date.now(),
  };
}

async function addManualWord(formData) {
  const level = String(formData.get("level") || "A1");
  const word = String(formData.get("word") || "").trim();
  const ipa = String(formData.get("ipa") || "").trim();
  const meaningZh = String(formData.get("meaningZh") || "").trim();
  const exampleIt = String(formData.get("exampleIt") || "").trim();
  const exampleZh = String(formData.get("exampleZh") || "").trim();
  if (!word || !meaningZh) return;

  const now = Date.now();
  const manualWord = normalizeManualWord({
    id: `manual_${now}_${slugify(word)}`,
    level,
    word,
    ipa,
    meaningZh,
    examples: exampleIt || exampleZh ? [{ it: exampleIt, zh: exampleZh }] : [],
    createdAt: now,
    updatedAt: now,
  });

  await idbPut("manualWords", manualWord);
  app.manualWords = [...app.manualWords.filter((item) => item.id !== manualWord.id), manualWord];
  indexContent(app.content, app.manualWords);
  await reopenVocabularySessionForLevel(manualWord.level);
  app.ui.manualLevel = manualWord.level;
  await saveUIState();

  const form = document.querySelector("#manual-word-form");
  form.reset();
  document.querySelector("#manual-level").value = manualWord.level;
  await renderManual();
}

async function deleteManualWord(wordID) {
  await idbDelete("manualWords", wordID);
  await idbDelete("wordStats", wordID);
  app.manualWords = app.manualWords.filter((word) => word.id !== wordID);
  indexContent(app.content, app.manualWords);
  await renderManual();
}

async function reopenVocabularySessionForLevel(level) {
  const session = await getVocabularySession(level);
  if (session.isCycleCompleted && session.pageHistory.length < session.totalPages) {
    session.isCycleCompleted = false;
    session.currentPageIndex = Math.max(0, session.pageHistory.length - 1);
    await saveVocabularySession(session);
  }
}

async function markWordsSeen(wordIDs) {
  const now = Date.now();
  for (const wordID of wordIDs) {
    const stat = await getWordStat(wordID);
    stat.lastSeenAt = now;
    await putWordStat(stat);
  }
}

async function getVocabularySession(level) {
  const totalWords = app.wordsByLevel.get(level)?.length || 0;
  const totalPages = Math.ceil(totalWords / PAGE_SIZE);
  const saved = await idbGet("vocabularySessions", level);
  if (saved) {
    saved.pageHistory = Array.isArray(saved.pageHistory) ? saved.pageHistory : [];
    saved.totalPages = totalPages;
    saved.currentPageIndex = clamp(saved.currentPageIndex || 0, 0, Math.max(0, saved.pageHistory.length - 1));
    return saved;
  }
  return {
    level,
    currentPageIndex: 0,
    totalPages,
    isCycleCompleted: false,
    pageHistory: [],
    updatedAt: Date.now(),
  };
}

async function saveVocabularySession(session) {
  session.updatedAt = Date.now();
  await idbPut("vocabularySessions", session);
}

async function ensureTrainingPage(level) {
  const session = await getVocabularySession(level);
  if (session.totalPages === 0) return session;
  if (session.pageHistory.length === 0) {
    await appendTrainingPage(session);
  }
  return session;
}

async function appendTrainingPage(session) {
  const allWords = app.wordsByLevel.get(session.level) || [];
  const used = new Set(session.pageHistory.flat());
  const remaining = allWords.filter((word) => !used.has(word.id));
  const pageWords = shuffle(remaining).slice(0, PAGE_SIZE);
  const ids = pageWords.map((word) => word.id);
  if (ids.length > 0) {
    session.pageHistory.push(ids);
    session.currentPageIndex = session.pageHistory.length - 1;
    await markWordsSeen(ids);
    await saveVocabularySession(session);
  }
}

async function renderVocabulary() {
  document.querySelector("#vocabulary-level").value = app.ui.vocabularyLevel;
  if (app.ui.vocabularyMode === "unmastered") {
    await renderUnmastered();
    return;
  }
  await renderTraining();
}

async function renderTraining() {
  const level = app.ui.vocabularyLevel;
  const words = app.wordsByLevel.get(level) || [];
  const session = await ensureTrainingPage(level);
  const stats = await idbGetAll("wordStats");
  const revealed = stats.filter((stat) => {
    const word = app.wordsByID.get(stat.wordID);
    return word?.level === level && stat.meaningRevealCount > 0;
  }).length;

  document.querySelector("#vocabulary-summary").innerHTML = summaryHTML([
    ["等级词数", words.length],
    ["总页数", session.totalPages],
    ["已点释义", revealed],
    ["未点释义", Math.max(0, words.length - revealed)],
  ]);

  if (session.totalPages === 0) {
    document.querySelector("#vocabulary-content").innerHTML = emptyHTML("暂无词汇内容");
    document.querySelector("#vocabulary-controls").innerHTML = "";
    return;
  }

  if (session.isCycleCompleted) {
    document.querySelector("#vocabulary-content").innerHTML = `
      <div class="completion">
        <h3>${esc(level)} 本轮学习完成</h3>
        <p>你已经完成该等级全部词汇的一轮学习；这不等于全部掌握，建议继续复习未掌握词汇。</p>
        <button class="primary" type="button" data-action="reset-cycle">重开本轮</button>
      </div>
    `;
    document.querySelector("#vocabulary-controls").innerHTML = "";
    return;
  }

  const ids = session.pageHistory[session.currentPageIndex] || [];
  const pageWords = ids.map((id) => app.wordsByID.get(id)).filter(Boolean);
  document.querySelector("#vocabulary-content").innerHTML = wordListHTML(pageWords, "show-training-word");

  const onLastPage = session.currentPageIndex === session.totalPages - 1;
  const hasGeneratedLast = session.pageHistory.length >= session.totalPages;
  const primaryAction = onLastPage && hasGeneratedLast ? "complete-cycle" : "next-training";
  const primaryTitle = onLastPage && hasGeneratedLast ? "完成本轮" : "下一页";
  document.querySelector("#vocabulary-controls").innerHTML = `
    <button type="button" data-action="previous-training" ${session.currentPageIndex <= 0 ? "disabled" : ""}>上一页</button>
    <strong>${session.currentPageIndex + 1}/${session.totalPages}</strong>
    <button class="primary" type="button" data-action="${primaryAction}">${primaryTitle}</button>
  `;
}

async function revealTrainingWord(wordID) {
  if (app.trainingVisible.has(wordID)) {
    app.trainingVisible.delete(wordID);
  } else {
    const stat = await getWordStat(wordID);
    stat.meaningRevealCount += 1;
    stat.lastRevealedAt = Date.now();
    await putWordStat(stat);
    app.trainingVisible.add(wordID);
  }
  await renderTraining();
}

async function previousTrainingPage() {
  const session = await getVocabularySession(app.ui.vocabularyLevel);
  if (session.currentPageIndex <= 0) return;
  session.currentPageIndex -= 1;
  app.trainingVisible = new Set();
  await saveVocabularySession(session);
  await renderTraining();
  scrollToPageTop();
}

async function nextTrainingPage() {
  const session = await getVocabularySession(app.ui.vocabularyLevel);
  if (session.currentPageIndex < session.pageHistory.length - 1) {
    session.currentPageIndex += 1;
    app.trainingVisible = new Set();
    await saveVocabularySession(session);
    await renderTraining();
    scrollToPageTop();
    return;
  }
  if (session.pageHistory.length < session.totalPages) {
    app.trainingVisible = new Set();
    await appendTrainingPage(session);
    await renderTraining();
    scrollToPageTop();
  }
}

async function completeTrainingCycle() {
  const session = await getVocabularySession(app.ui.vocabularyLevel);
  session.isCycleCompleted = true;
  session.currentPageIndex = Math.max(0, session.totalPages - 1);
  await saveVocabularySession(session);
  await renderTraining();
  scrollToPageTop();
}

async function resetTrainingCycle() {
  const level = app.ui.vocabularyLevel;
  const totalWords = app.wordsByLevel.get(level)?.length || 0;
  const session = {
    level,
    currentPageIndex: 0,
    totalPages: Math.ceil(totalWords / PAGE_SIZE),
    isCycleCompleted: false,
    pageHistory: [],
    updatedAt: Date.now(),
  };
  app.trainingVisible = new Set();
  await appendTrainingPage(session);
  await renderTraining();
  scrollToPageTop();
}

async function renderUnmastered() {
  const allStats = await idbGetAll("wordStats");
  const ids = allStats
    .filter((stat) => stat.meaningRevealCount > 0 && (stat.unmasteredRevealCount || 0) < 3)
    .sort((left, right) => (right.lastRevealedAt || 0) - (left.lastRevealedAt || 0))
    .map((stat) => stat.wordID)
    .filter((id) => app.wordsByID.has(id));
  const totalPages = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
  app.ui.unmasteredPageIndex = clamp(app.ui.unmasteredPageIndex, 0, totalPages - 1);
  await saveUIState();
  const start = app.ui.unmasteredPageIndex * PAGE_SIZE;
  const pageWords = ids.slice(start, start + PAGE_SIZE).map((id) => app.wordsByID.get(id)).filter(Boolean);

  document.querySelector("#vocabulary-summary").innerHTML = summaryHTML([
    ["未掌握总数", ids.length],
    ["当前页", ids.length ? `${app.ui.unmasteredPageIndex + 1}/${totalPages}` : "0/0"],
    ["移除规则", "复习3次"],
    ["记忆位置", "本机浏览器"],
  ]);

  document.querySelector("#vocabulary-content").innerHTML = `
    <div class="button-row" style="margin-bottom: 12px;">
      <button type="button" data-action="back-training">返回单词本</button>
    </div>
    ${pageWords.length ? wordListHTML(pageWords, "show-unmastered-word") : emptyHTML("暂无未掌握单词")}
  `;
  document.querySelector("#vocabulary-controls").innerHTML = `
    <button type="button" data-action="previous-unmastered" ${app.ui.unmasteredPageIndex <= 0 ? "disabled" : ""}>上一页</button>
    <strong>${ids.length ? app.ui.unmasteredPageIndex + 1 : 0}/${ids.length ? totalPages : 0}</strong>
    <button class="primary" type="button" data-action="next-unmastered" ${app.ui.unmasteredPageIndex + 1 >= totalPages ? "disabled" : ""}>下一页</button>
  `;
}

async function revealUnmasteredWord(wordID) {
  if (app.unmasteredVisible.has(wordID)) {
    app.unmasteredVisible.delete(wordID);
  } else {
    const stat = await getWordStat(wordID);
    stat.meaningRevealCount += 1;
    stat.unmasteredRevealCount = (stat.unmasteredRevealCount || 0) + 1;
    await putWordStat(stat);
    app.unmasteredVisible.add(wordID);
  }
  await renderUnmastered();
}

async function shiftUnmasteredPage(delta) {
  app.ui.unmasteredPageIndex = Math.max(0, app.ui.unmasteredPageIndex + delta);
  app.unmasteredVisible = new Set();
  await saveUIState();
  await renderUnmastered();
  scrollToPageTop();
}

function wordListHTML(words, action) {
  return `<div class="word-list">${words.map((word) => {
    const visible = action === "show-training-word" ? app.trainingVisible.has(word.id) : app.unmasteredVisible.has(word.id);
    const badge = word.source === "manual" ? `${word.level} · 自添` : word.level;
    return `
      <article class="word-card">
        <div class="word-main">
          <div>
            <div class="word-title">${esc(word.word)}</div>
            <div class="ipa">${esc(word.ipa || "-")}</div>
          </div>
          <span class="badge">${esc(badge)}</span>
        </div>
        <div class="meaning">
          ${visible ? `<strong>${esc(word.meaningZh)}</strong>${examplesHTML(word.examples)}` : `<span class="muted">中文释义已隐藏</span>`}
        </div>
        <div class="button-row">
          <button type="button" data-action="${action}" data-word-i-d="${escAttr(word.id)}">${visible ? "隐藏释义" : "显示释义"}</button>
          <button type="button" data-action="speak" data-text="${escAttr(word.word)}">朗读</button>
        </div>
      </article>
    `;
  }).join("")}</div>`;
}

function examplesHTML(examples) {
  if (!examples || examples.length === 0) return "";
  return `<div class="examples">${examples.map((example) => `
    <div><span>${esc(example.it)}</span>${example.zh ? `<br><span>${esc(example.zh)}</span>` : ""}</div>
  `).join("")}</div>`;
}

async function renderManual() {
  document.querySelector("#manual-level").value = app.ui.manualLevel;
  const byLevel = new Map(app.content.levels.map((level) => [level, 0]));
  for (const word of app.manualWords) byLevel.set(word.level, (byLevel.get(word.level) || 0) + 1);
  const latest = [...app.manualWords].sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));

  document.querySelector("#manual-summary").innerHTML = summaryHTML([
    ["手动词数", app.manualWords.length],
    ["当前等级", app.ui.manualLevel],
    ["本等级手动词", byLevel.get(app.ui.manualLevel) || 0],
    ["混入单词本", "已启用"],
  ]);

  document.querySelector("#manual-list").innerHTML = latest.length ? `
    <div class="word-list">
      ${latest.map((word) => `
        <article class="word-card">
          <div class="word-main">
            <div>
              <div class="word-title">${esc(word.word)}</div>
              <div class="ipa">${esc(word.ipa || "-")}</div>
            </div>
            <span class="badge">${esc(word.level)} · 自添</span>
          </div>
          <div class="meaning">
            <strong>${esc(word.meaningZh)}</strong>
            ${examplesHTML(word.examples)}
          </div>
          <div class="button-row">
            <button type="button" data-action="speak" data-text="${escAttr(word.word)}">朗读</button>
            <button class="danger" type="button" data-action="delete-manual-word" data-manual-i-d="${escAttr(word.id)}">删除</button>
          </div>
        </article>
      `).join("")}
    </div>
  ` : emptyHTML("暂无手动添加的单词");
}

async function renderGrammar() {
  if (app.ui.grammarDetailID) {
    renderGrammarDetail(app.ui.grammarDetailID);
    return;
  }
  document.querySelector("#grammar-content").innerHTML = app.content.levels.map((level) => {
    const points = app.grammarByLevel.get(level) || [];
    return `
      <section class="level-group">
        <h3>${esc(level)} 核心语法 <span class="badge">${points.length}</span></h3>
        <div class="card-list" style="margin-top: 10px;">
          ${points.length ? points.map((point) => `
            <button class="grammar-item" type="button" data-action="open-grammar" data-grammar-i-d="${escAttr(point.id)}">
              <strong>${esc(point.title)}</strong>
              <span class="muted">${esc(point.whenToUse)}</span>
            </button>
          `).join("") : emptyHTML("暂无内容")}
        </div>
      </section>
    `;
  }).join("");
}

function renderGrammarDetail(grammarID) {
  const point = app.grammarByID.get(grammarID);
  if (!point) {
    app.ui.grammarDetailID = null;
    renderGrammar();
    return;
  }
  const quiz = app.questions.grammarQuiz[grammarID] || [];
  document.querySelector("#grammar-content").innerHTML = `
    <div class="detail-stack">
      <div class="button-row">
        <button type="button" data-action="back-grammar">返回语法列表</button>
      </div>
      <article class="panel-card">
        <h3>${esc(point.level)} · ${esc(point.title)}</h3>
        ${infoBlock("使用时机", point.whenToUse)}
        ${infoBlock("构成", point.structure)}
        ${infoBlock("规则", point.rules)}
      </article>
      <article class="panel-card">
        <div class="section-title">例句</div>
        ${point.examples?.length ? examplesHTML(point.examples) : `<p class="muted">暂无例句</p>`}
      </article>
      <article class="panel-card">
        <h3>本组测试题</h3>
        ${quiz.length ? quiz.map((q) => questionHTML(q, app.grammarAnswers.get(q.id), "answer-grammar")).join("") : emptyHTML("暂无本地测试题")}
      </article>
    </div>
  `;
}

function questionHTML(question, selected, action) {
  const answered = selected !== undefined;
  const correct = answered && selected === question.answerIndex;
  return `
    <div class="question-card">
      <strong>${esc(question.stem)}</strong>
      <div class="options">
        ${question.options.map((option, index) => {
          const classes = ["option"];
          if (answered && index === question.answerIndex) classes.push("correct");
          if (answered && index === selected && index !== question.answerIndex) classes.push("wrong");
          return `<button class="${classes.join(" ")}" type="button" data-action="${action}" data-question-i-d="${escAttr(question.id)}" data-answer="${index}" ${answered ? "disabled" : ""}>${esc(option)}</button>`;
        }).join("")}
      </div>
      ${answered ? `<div class="result ${correct ? "ok" : "bad"}">${correct ? "正确" : `错误，正确答案：${esc(question.options[question.answerIndex])}`}<br><span class="muted">${esc(question.explanationZh)}</span></div>` : ""}
    </div>
  `;
}

async function renderExam() {
  const content = document.querySelector("#exam-content");
  content.innerHTML = `
    <div class="split-controls">
      <button class="mode-button ${app.ui.examMode === "exam" ? "active" : ""}" type="button" data-action="exam-mode" data-mode="exam">出题测试</button>
      <button class="mode-button ${app.ui.examMode === "wrongSet" ? "active" : ""}" type="button" data-action="exam-mode" data-mode="wrongSet">错题集合</button>
    </div>
    <div id="exam-mode-content"></div>
  `;
  if (app.ui.examMode === "wrongSet") {
    await renderWrongSet();
  } else {
    renderExamGenerator();
  }
}

function renderExamGenerator() {
  const target = document.querySelector("#exam-mode-content");
  if (!app.examSession) {
    target.innerHTML = `
      <div class="panel-card detail-stack">
        <label>
          <span>等级</span>
          <select id="exam-level">${app.content.levels.map((level) => `<option value="${level}" ${level === app.ui.examLevel ? "selected" : ""}>${level}</option>`).join("")}</select>
        </label>
        <button class="primary" type="button" data-action="start-exam">生成试卷</button>
      </div>
    `;
    return;
  }
  if (app.examSession.completed) {
    const correct = app.examSession.answers.filter((answer, index) => answer === app.examSession.questions[index].answerIndex).length;
    const total = app.examSession.questions.length;
    target.innerHTML = `
      <div class="completion">
        <h3>本次成绩</h3>
        <p>得分：${correct}/${total}</p>
        <p>正确 ${correct} 题｜错误 ${total - correct} 题｜得分率 ${total ? Math.round((correct / total) * 100) : 0}%</p>
        <button class="primary" type="button" data-action="start-exam">再生成一套试卷</button>
      </div>
    `;
    return;
  }
  const q = app.examSession.questions[app.examSession.index];
  target.innerHTML = `
    <div class="panel-card">
      <p class="muted">${app.examSession.index + 1}/${app.examSession.questions.length}</p>
      ${questionHTML(q, app.examSession.answers[app.examSession.index], "answer-exam")}
      ${app.examSession.answers[app.examSession.index] !== undefined ? `<div class="button-row"><button class="primary" type="button" data-action="next-exam">${app.examSession.index + 1 === app.examSession.questions.length ? "查看结果" : "下一题"}</button></div>` : ""}
    </div>
  `;
}

async function startExam() {
  const questions = [...(app.questions.exams[app.ui.examLevel] || [])];
  app.examSession = {
    questions: shuffle(questions).slice(0, 20),
    index: 0,
    answers: [],
    completed: false,
  };
  renderExamGenerator();
}

async function answerExam(answer) {
  if (!app.examSession) return;
  const q = app.examSession.questions[app.examSession.index];
  if (app.examSession.answers[app.examSession.index] !== undefined) return;
  app.examSession.answers[app.examSession.index] = answer;
  const isCorrect = answer === q.answerIndex;
  const stat = (await idbGet("questionStats", q.id)) || {
    questionID: q.id,
    level: q.level,
    wrongCount: 0,
    correctStreak: 0,
    question: q,
    lastWrongAt: null,
    lastSeenAt: null,
  };
  stat.question = q;
  stat.lastSeenAt = Date.now();
  if (!isCorrect) {
    stat.wrongCount += 1;
    stat.correctStreak = 0;
    stat.lastWrongAt = Date.now();
  }
  await idbPut("questionStats", stat);
  renderExamGenerator();
}

async function nextExamQuestion() {
  if (!app.examSession) return;
  if (app.examSession.index + 1 >= app.examSession.questions.length) {
    app.examSession.completed = true;
  } else {
    app.examSession.index += 1;
  }
  renderExamGenerator();
  scrollToPageTop();
}

async function renderWrongSet() {
  const target = document.querySelector("#exam-mode-content");
  if (app.ui.wrongSetLevel) {
    await openWrongSet(app.ui.wrongSetLevel, false);
    return;
  }
  const stats = await idbGetAll("questionStats");
  const rows = app.content.levels.map((level) => {
    const count = stats.filter((stat) => stat.level === level && stat.wrongCount > 0 && stat.question).length;
    return `
      <button class="grammar-item" type="button" data-action="open-wrong-set" data-level="${level}">
        <strong>${level}</strong>
        <span class="muted">错题 ${count}</span>
      </button>
    `;
  }).join("");
  target.innerHTML = `<div class="card-list">${rows}</div>`;
}

async function openWrongSet(level, rerender = true) {
  const stats = await idbGetAll("questionStats");
  const items = shuffle(stats.filter((stat) => stat.level === level && stat.wrongCount > 0 && stat.question));
  if (!app.wrongSetSession || app.wrongSetSession.level !== level || rerender) {
    app.wrongSetSession = {
      level,
      items,
      index: 0,
      selected: undefined,
      removedCurrent: false,
      pendingRemovalID: null,
    };
  }
  renderWrongSetQuestion();
}

function renderWrongSetQuestion() {
  const target = document.querySelector("#exam-mode-content");
  const session = app.wrongSetSession;
  if (!session || session.items.length === 0) {
    target.innerHTML = `
      <div class="button-row" style="margin-bottom: 12px;"><button type="button" data-action="back-wrong-levels">返回等级列表</button></div>
      ${emptyHTML("该等级暂无错题")}
    `;
    return;
  }
  const item = session.items[session.index];
  target.innerHTML = `
    <div class="button-row" style="margin-bottom: 12px;"><button type="button" data-action="back-wrong-levels">返回等级列表</button></div>
    <div class="panel-card">
      <p class="muted">${session.level} 错题练习 · ${session.index + 1}/${session.items.length} · 错 ${item.wrongCount} 次 · 连对 ${item.correctStreak || 0} 次</p>
      ${questionHTML(item.question, session.selected, "answer-wrong-set")}
      ${session.removedCurrent ? `<p class="result ok">该题已连续答对 3 次，已从错题集合移除。</p>` : ""}
      ${session.selected !== undefined ? `<div class="button-row"><button class="primary" type="button" data-action="next-wrong-set">下一题</button></div>` : ""}
    </div>
  `;
}

async function answerWrongSet(answer) {
  const session = app.wrongSetSession;
  if (!session || session.selected !== undefined) return;
  const item = session.items[session.index];
  const isCorrect = answer === item.question.answerIndex;
  const stat = (await idbGet("questionStats", item.questionID)) || item;
  stat.lastSeenAt = Date.now();
  if (isCorrect) {
    stat.correctStreak = (stat.correctStreak || 0) + 1;
    if (stat.correctStreak >= 3) {
      stat.wrongCount = 0;
      stat.correctStreak = 0;
      session.removedCurrent = true;
      session.pendingRemovalID = item.questionID;
    }
  } else {
    stat.wrongCount = (stat.wrongCount || 0) + 1;
    stat.correctStreak = 0;
    stat.lastWrongAt = Date.now();
  }
  await idbPut("questionStats", stat);
  session.selected = answer;
  renderWrongSetQuestion();
}

async function nextWrongSetQuestion() {
  const session = app.wrongSetSession;
  if (!session) return;
  if (session.pendingRemovalID) {
    session.items = session.items.filter((item) => item.questionID !== session.pendingRemovalID);
    session.pendingRemovalID = null;
  }
  session.selected = undefined;
  session.removedCurrent = false;
  if (session.items.length === 0) {
    renderWrongSetQuestion();
    scrollToPageTop();
    return;
  }
  if (session.index + 1 < session.items.length) {
    session.index += 1;
  } else {
    session.index = 0;
  }
  renderWrongSetQuestion();
  scrollToPageTop();
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "it-IT";
  window.speechSynthesis.speak(utterance);
}

function summaryHTML(items) {
  return items.map(([label, value]) => `
    <div class="stat"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>
  `).join("");
}

function infoBlock(title, text) {
  return `<div><div class="section-title">${esc(title)}</div><p>${esc(text)}</p></div>`;
}

function emptyHTML(text) {
  return `<div class="empty">${esc(text)}</div>`;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scrollToPageTop() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  });
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return slug || "word";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escAttr(value) {
  return esc(value);
}

function showStatus(message) {
  const status = document.querySelector("#status");
  status.textContent = message;
  status.classList.add("visible");
}

function hideStatus() {
  document.querySelector("#status").classList.remove("visible");
}
