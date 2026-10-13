"use strict";
const STORAGE_KEY = "studio-order-ledger-v2";
const LEGACY_STORAGE_KEY = "studio-order-ledger-v1";
const CURRENT_COHORT_KEY = "studio-order-ledger-current-cohort-v1";
const DEFAULTS_KEY = "studio-order-ledger-entry-defaults-v1";
const AI_CONFIG_KEY = "studio-order-ledger-deepseek-v1";
const MIGRATION_BACKUP_KEY = "studio-order-ledger-before-payment-history";
const WORK_COST_BACKUP_KEY = "studio-order-ledger-before-work-cost-split";
const DATA_VERSION = 6;
const MAX_CENTS = 100000000000;
const COHORTS = ["22级", "23级", "24级", "25级", "26级", "其他"];
const WECHATS = ["微信1", "微信2", "微信3", "微信4"];
const DEFAULT_MEMBERS = ["刘耀新", "张伟杰", "方可", "王杰", "邓立青", "程志"];
const CONTENT_TYPES = ["实物", "论文"];
const $ = (selector) => document.querySelector(selector);
const money = (cents) => "¥" + (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amountText = (cents) => (cents / 100).toFixed(2);
let orders = [], currentCohort = "", editingId = null, paymentEditingId = null;
let members = [...DEFAULT_MEMBERS];
let paymentMode = "receipt", entryDefaults = {}, dataReady = true, toastTimer;
let aiConfig = { apiKey: "", model: "deepseek-flash" }, aiRequestController = null;
const WORK_FIELDS = { "实物": ["physicalMember", "physicalCost", "physicalWorkFields"], "论文": ["paperMember", "paperCost", "paperWorkFields"] };

function today() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message; toast.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00");
  return !Number.isNaN(date.getTime()) &&
    date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") === value;
}
function parseMoney(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}
function totalCents(order) { return order.receivableCents; }
function dueCents(order) { return Math.max(totalCents(order) - order.paidCents, 0); }
function profitCents(order) { return totalCents(order) - order.memberCostCents; }
function workItem(order, type) { return order.workItems.find(item => item.type === type); }
function workerNames(order) { return [...new Set(order.workItems.map(item => item.member).filter(Boolean))]; }
function knownMembers() { return [...new Set([...members, ...orders.flatMap(workerNames)])]; }
function validMembers(names) {
  return Array.isArray(names) && names.length <= 1000 && names.every(name => typeof name === "string" &&
    name.trim() === name && name.length > 0 && name.length <= 100 && name !== "待分配") &&
    new Set(names.map(name => name.toLocaleLowerCase("zh-CN"))).size === names.length;
}
function memberRosterWith(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 100 || name === "待分配") throw new Error("请填写有效的成员姓名，最多 100 字。");
  if (members.some(item => item.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) throw new Error("这个成员已在名单中。");
  if (members.length >= 1000) throw new Error("成员名单已达到上限。");
  return [...members, name];
}
function inferTypes(content) {
  const types = CONTENT_TYPES.filter((type) => String(content || "").includes(type));
  return types.length ? types : ["论文"];
}
function makePaymentEntry(amountCents, paidAfterCents, kind, date, note) {
  return { id: crypto.randomUUID(), amountCents, paidAfterCents, kind, date, note };
}
// Carry old balances without inventing a receipt date or limiting overpayments.
function normalizeOrder(source, index = 0) {
  if (!source || typeof source !== "object") return null;
  const modern = Number.isSafeInteger(source.depositCents);
  if (!modern && !Number.isSafeInteger(source.priceCents)) return null;
  const paidCents = source.paidCents ?? 0;
  const depositCents = modern ? source.depositCents : Math.max(0, Math.min(paidCents, source.priceCents));
  const tailCents = modern ? source.tailCents : source.priceCents - depositCents;
  const extraCents = modern ? source.extraCents ?? 0 : 0;
  const receivableCents = source.receivableCents ?? (depositCents + tailCents + extraCents);
  const memberCostCents = source.memberCostCents ?? 0;
  const types = Array.isArray(source.types) ? CONTENT_TYPES.filter(type => source.types.includes(type)) : inferTypes(source.content);
  const hasWorkItems = source.workItems !== undefined;
  // A single task has an unambiguous fee. Preserve mixed legacy fees until the user splits them.
  const workItems = hasWorkItems ? source.workItems : types.map(type => ({ type, member: "",
    costCents: types.length === 1 ? memberCostCents : 0 }));
  const unallocatedMemberCostCents = hasWorkItems ? source.unallocatedMemberCostCents ?? 0 : (types.length === 1 ? 0 : memberCostCents);
  if (!Array.isArray(workItems) || workItems.some(item => !item || !Number.isSafeInteger(item.costCents))) return null;
  const calculatedCost = workItems.reduce((sum, item) => sum + item.costCents, unallocatedMemberCostCents);
  if (hasWorkItems && source.memberCostCents !== undefined && source.memberCostCents !== calculatedCost) return null;
  const payments = source.payments === undefined ?
    (paidCents > 0 ? [makePaymentEntry(paidCents, paidCents, "opening", "", "原账本已收")] : []) : source.payments;
  return {
    id: String(source.id || "legacy-" + index), cohort: COHORTS.includes(source.cohort) ? source.cohort : "其他",
    date: source.date, wechat: WECHATS.includes(source.wechat) ? source.wechat : WECHATS[0],
    code: String(source.code || "").trim(), title: String(source.title || "").trim(),
    types,
    ...(source.assignee ? { assignee: String(source.assignee).trim() } : {}),
    depositCents, tailCents, extraCents, receivableCents, paidCents, memberCostCents: calculatedCost,
    workItems, unallocatedMemberCostCents, payments
  };
}
function validPayments(payments, paidCents) {
  if (!Array.isArray(payments) || payments.length > 10000) return false;
  let running = 0;
  const ids = new Set();
  for (const entry of payments) {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
      !Number.isSafeInteger(entry.amountCents) || Math.abs(entry.amountCents) > MAX_CENTS ||
      !Number.isSafeInteger(entry.paidAfterCents) || entry.paidAfterCents < 0 || entry.paidAfterCents > MAX_CENTS ||
      !["opening", "receipt", "adjustment"].includes(entry.kind) ||
      !(validDate(entry.date) || (entry.kind === "opening" && entry.date === "")) ||
      typeof entry.note !== "string" || entry.note.length > 100 ||
      (entry.kind !== "adjustment" && entry.amountCents <= 0)) return false;
    running += entry.amountCents;
    if (running < 0 || running > MAX_CENTS || running !== entry.paidAfterCents) return false;
    ids.add(entry.id);
  }
  return running === paidCents;
}
function isValidOrder(order) {
  return !!order && typeof order.id === "string" && order.id.length > 0 && order.id.length <= 100 &&
    COHORTS.includes(order.cohort) && validDate(order.date) && WECHATS.includes(order.wechat) &&
    typeof order.code === "string" && order.code.length > 0 && order.code.length <= 40 &&
    typeof order.title === "string" && order.title.length > 0 && order.title.length <= 150 &&
    Array.isArray(order.types) && order.types.length > 0 && new Set(order.types).size === order.types.length && order.types.every((type) => CONTENT_TYPES.includes(type)) &&
    Array.isArray(order.workItems) && order.workItems.length === order.types.length &&
    new Set(order.workItems.map(item => item?.type)).size === order.types.length &&
    order.workItems.every(item => item && order.types.includes(item.type) && typeof item.member === "string" && item.member.length <= 100 &&
      Number.isSafeInteger(item.costCents) && item.costCents >= 0 && item.costCents <= MAX_CENTS) &&
    Number.isSafeInteger(order.unallocatedMemberCostCents) && order.unallocatedMemberCostCents >= 0 && order.unallocatedMemberCostCents <= MAX_CENTS &&
    order.memberCostCents === order.workItems.reduce((sum, item) => sum + item.costCents, order.unallocatedMemberCostCents) &&
    (order.assignee === undefined || (typeof order.assignee === "string" && order.assignee.length > 0 && order.assignee.length <= 100)) &&
    ["depositCents", "tailCents", "extraCents", "receivableCents", "paidCents", "memberCostCents"].every(
      (key) => Number.isSafeInteger(order[key]) && order[key] >= 0 && order[key] <= MAX_CENTS
    ) && order.receivableCents > 0 && validPayments(order.payments, order.paidCents);
}
function orderCodeKey(order) { return order.cohort + ":" + order.code.toLocaleLowerCase("zh-CN"); }
function validateCollection(items) {
  if (!Array.isArray(items) || items.length > 50000 || !items.every(isValidOrder)) return false;
  const ids = new Set(), codes = new Set();
  for (const item of items) {
    const code = orderCodeKey(item);
    if (ids.has(item.id) || codes.has(code)) return false;
    ids.add(item.id); codes.add(code);
  }
  return true;
}
function saveOrders(next, restoring = false, nextMembers = members) {
  if (!dataReady && !restoring) { showToast("已有数据无法读取，请先恢复有效备份。"); return false; }
  if (!validateCollection(next) || !validMembers(nextMembers)) { showToast("数据格式不完整，未保存。"); return false; }
  try {
    const previous = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (previous && !localStorage.getItem(MIGRATION_BACKUP_KEY)) localStorage.setItem(MIGRATION_BACKUP_KEY, previous);
    if (previous && !localStorage.getItem(WORK_COST_BACKUP_KEY)) {
      let previousVersion = 0;
      try { previousVersion = JSON.parse(previous).version || 1; } catch {}
      if (previousVersion < 5) localStorage.setItem(WORK_COST_BACKUP_KEY, previous);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: DATA_VERSION, members: nextMembers, orders: next }));
    orders = next; members = [...nextMembers]; dataReady = true; render(); return true;
  } catch { showToast("保存失败，请先备份已有数据。"); return false; }
}
function loadOrders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved.orders) || (saved.version && saved.version > DATA_VERSION)) throw new Error("invalid");
    const normalized = saved.orders.map(normalizeOrder);
    if (!validateCollection(normalized)) throw new Error("invalid");
    if (saved.members !== undefined && !validMembers(saved.members)) throw new Error("invalid");
    orders = normalized;
    members = [...new Set([...DEFAULT_MEMBERS, ...(saved.members || [])])];
  } catch { dataReady = false; showToast("已有账本数据无法读取，请通过备份恢复。"); }
}
function loadPreferences() {
  try {
    const saved = localStorage.getItem(CURRENT_COHORT_KEY);
    currentCohort = COHORTS.includes(saved) ? saved : "";
    entryDefaults = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}") || {};
  } catch { entryDefaults = {}; }
}
function saveCurrentCohort(cohort) {
  if (!COHORTS.includes(cohort)) return false;
  try { localStorage.setItem(CURRENT_COHORT_KEY, cohort); currentCohort = cohort; return true; }
  catch { showToast("年级保存失败，请重试。"); return false; }
}
function paymentState(order) {
  if (order.paidCents >= totalCents(order)) return "paid";
  return order.paidCents === 0 ? "unpaid" : "partial";
}
function paymentLabel(state) { return ({ unpaid: "未收款", partial: "部分收款", paid: "已结清" })[state]; }
function makeOption(text, value, selected = false) { const option = new Option(text, value); option.selected = selected; return option; }
function visibleOrders() {
  if (!currentCohort) return [];
  const query = $("#searchInput").value.trim().toLocaleLowerCase("zh-CN");
  const wechat = $("#wechatFilter").value, payment = $("#paymentFilter").value;
  const worker = $("#workerFilter").value;
  return orders.filter((order) => {
    const haystack = [order.code, order.title, order.types.join(" "), order.wechat, ...workerNames(order)].join(" ").toLocaleLowerCase("zh-CN");
    return order.cohort === currentCohort && (!query || haystack.includes(query)) &&
      (!wechat || order.wechat === wechat) && (!worker || workerNames(order).includes(worker)) &&
      (!payment || (payment === "due" ? dueCents(order) > 0 : paymentState(order) === payment));
  }).sort((a, b) => b.date.localeCompare(a.date) || b.code.localeCompare(a.code, "zh-CN", { numeric: true }));
}
function summarize(items) {
  return items.reduce((sum, order) => {
    sum.total += totalCents(order); sum.paid += order.paidCents; sum.due += dueCents(order);
    sum.memberCost += order.memberCostCents; sum.profit += profitCents(order); return sum;
  }, { total: 0, paid: 0, due: 0, memberCost: 0, profit: 0 });
}
function appendCell(row, children, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  children.forEach((child) => cell.append(child)); row.append(cell); return cell;
}
function span(text, className = "") {
  const item = document.createElement("span"); item.className = className; item.textContent = text; return item;
}
function actionButton(text, handler, className = "") {
  const button = document.createElement("button"); button.type = "button"; button.className = className;
  button.textContent = text; button.addEventListener("click", handler); return button;
}
function wechatAvatar(wechat) {
  const image = document.createElement("img");
  image.src = "assets/wechat/wechat-" + (WECHATS.indexOf(wechat) + 1) + ".jpg";
  image.alt = ""; image.className = "wechat-avatar"; image.width = 36; image.height = 36; return image;
}
function wechatBadge(wechat) {
  const badge = document.createElement("span"); badge.className = "wechat-badge";
  badge.append(wechatAvatar(wechat), span(wechat)); return badge;
}
function renderWechatChoices(selected) {
  $("#orderWechatChoices").replaceChildren(...WECHATS.map(wechat => {
    const label = document.createElement("label"); label.className = "wechat-choice";
    const input = document.createElement("input"); input.type = "radio"; input.name = "wechat";
    input.value = wechat; input.checked = wechat === selected; input.required = true;
    label.append(input, wechatBadge(wechat)); return label;
  }));
}
function renderWechatFilter() {
  const selected = $("#wechatFilter").value;
  const focused = !!document.activeElement?.closest("#wechatFilterChoices");
  const buttons = ["", ...WECHATS].map(wechat => {
    const button = actionButton(wechat || "全部微信", () => { $("#wechatFilter").value = wechat; render(); }, "wechat-filter-button");
    if (wechat) button.replaceChildren(wechatBadge(wechat));
    button.setAttribute("aria-pressed", String(wechat === selected)); return button;
  });
  $("#wechatFilterChoices").replaceChildren(...buttons);
  if (focused) buttons.find(button => button.getAttribute("aria-pressed") === "true").focus();
}
function renderRow(order) {
  const row = document.createElement("tr");
  appendCell(row, [span(order.code, "order-code"), span(order.date, "order-date")]);
  appendCell(row, [span(order.title, "order-title")]);
  const tags = document.createElement("div"); tags.className = "work-assignments";
  order.workItems.forEach(item => {
    const line = document.createElement("div"); line.className = "assignment-line";
    line.append(span(item.type, "content-tag"), span(item.member || "未分配", "worker-name")); tags.append(line);
  });
  appendCell(row, [tags]); appendCell(row, [wechatBadge(order.wechat)]);
  appendCell(row, [span(money(totalCents(order)), "money-value")], "money-cell");
  const paid = actionButton(money(order.paidCents), () => openPaymentDialog(order, "adjustment"), "paid-link");
  paid.setAttribute("aria-label", "修改订单 " + order.code + " 的已收金额，当前 " + money(order.paidCents));
  paid.title = "修改累计已收";
  appendCell(row, [paid], "money-cell");
  appendCell(row, [span(money(dueCents(order)), "payment-due")], "money-cell");
  const fees = [span(money(order.memberCostCents), "money-value")];
  if (order.workItems.length > 1) order.workItems.forEach(item => fees.push(span(item.type + " " + money(item.costCents), "work-fee")));
  if (order.unallocatedMemberCostCents) fees.push(span("待拆分 " + money(order.unallocatedMemberCostCents), "work-fee"));
  appendCell(row, fees, "money-cell");
  const profit = profitCents(order);
  appendCell(row, [span(money(profit), "profit-value" + (profit < 0 ? " loss" : ""))], "money-cell");
  const state = paymentState(order);
  appendCell(row, [span(paymentLabel(state), "status " + state)]);
  const actions = document.createElement("div"); actions.className = "row-actions";
  actions.append(actionButton("收款", () => openPaymentDialog(order), "payment-action"),
    actionButton("编辑", () => openDialog(order)), actionButton("删除", () => deleteOrder(order), "delete"));
  appendCell(row, [actions]); return row;
}
function renderFilters() {
  renderWechatFilter();
  const worker = $("#workerFilter"), selectedWorker = worker.value;
  worker.replaceChildren(makeOption("全部制作成员", ""));
  [...new Set(orders.filter(order => order.cohort === currentCohort).flatMap(workerNames))]
    .sort((a, b) => a.localeCompare(b, "zh-CN")).forEach(name => worker.append(makeOption(name, name)));
  worker.value = [...worker.options].some(option => option.value === selectedWorker) ? selectedWorker : "";
}
function clearFilters() {
  for (const id of ["searchInput", "wechatFilter", "workerFilter", "paymentFilter"]) $("#" + id).value = "";
}
function render() {
  renderFilters();
  const visible = visibleOrders(), totals = summarize(visible);
  $("#currentCohortLabel").textContent = currentCohort || "选择年级";
  $("#pageTitle").textContent = currentCohort ? currentCohort + "订单" : "订单";
  $("#summaryCount").textContent = String(visible.length);
  $("#summaryTotal").textContent = money(totals.total); $("#summaryPaid").textContent = money(totals.paid);
  $("#summaryDue").textContent = money(totals.due); $("#resultText").textContent = visible.length + " 笔";
  $("#summaryMemberCost").textContent = money(totals.memberCost);
  $("#summaryProfit").textContent = money(totals.profit);
  $("#summaryProfit").classList.toggle("loss", totals.profit < 0);
  $("#ordersBody").replaceChildren(...visible.map(renderRow));
  const empty = $("#emptyState"), hasOrders = orders.some((order) => order.cohort === currentCohort);
  empty.hidden = visible.length > 0;
  empty.querySelector("strong").textContent = !currentCohort ? "请先选择当前年级" :
    hasOrders ? "没有符合条件的订单" : "这个年级还没有订单";
  $("#emptyAdd").hidden = !currentCohort || hasOrders;
}
function fillSelect(select, options, selected = "") {
  const values = [...new Set([...options, ...(selected ? [selected] : [])])];
  select.replaceChildren(...values.map((item) => makeOption(item, item, item === selected)));
}
function refreshMemberSelects() {
  const fields = $("#orderForm").elements;
  for (const type of CONTENT_TYPES) {
    const select = fields[WORK_FIELDS[type][0]], selected = select.value;
    const names = [...new Set([...knownMembers(), ...(selected ? [selected] : [])])];
    select.replaceChildren(makeOption("未分配", "", !selected), ...names.map(name => makeOption(name, name, name === selected)));
  }
}
function openMembersDialog() {
  $("#membersList").replaceChildren(...members.map(name => { const item = document.createElement("li"); item.textContent = name; return item; }));
  $("#memberError").hidden = true; $("#memberForm").reset(); $("#membersDialog").showModal(); $("#newMemberName").focus();
}
function submitMember(event) {
  event.preventDefault();
  const input = $("#newMemberName");
  try {
    const next = memberRosterWith(input.value);
    if (!saveOrders(orders, false, next)) {
      $("#memberError").textContent = "成员保存失败，请先备份账本后重试。"; $("#memberError").hidden = false; return;
    }
    $("#membersList").replaceChildren(...members.map(name => { const item = document.createElement("li"); item.textContent = name; return item; }));
    if ($("#orderDialog").open) refreshMemberSelects();
    input.value = ""; $("#memberError").hidden = true; input.focus(); showToast("成员已添加");
  } catch (error) { $("#memberError").textContent = error.message; $("#memberError").hidden = false; input.focus(); }
}
function renderContentChoices(selected = []) {
  const wrap = $("#contentChoices"); wrap.replaceChildren();
  CONTENT_TYPES.forEach((type) => {
    const label = document.createElement("label"); label.className = "choice-button";
    const input = document.createElement("input"); input.type = "checkbox"; input.name = "types";
    input.value = type; input.checked = selected.includes(type); label.append(input, span(type)); wrap.append(label);
  });
}
function openCohortDialog(isFirst = false) {
  $("#cohortDialogTitle").textContent = isFirst ? "选择当前年级" : "切换当前年级";
  fillSelect($("#cohortSelect"), COHORTS, currentCohort || "23级"); $("#cancelCohort").hidden = isFirst;
  if (!$("#cohortDialog").open) $("#cohortDialog").showModal();
}
function submitCohort(event) {
  event.preventDefault(); if (!saveCurrentCohort($("#cohortSelect").value)) return;
  $("#cohortDialog").close(); clearFilters(); render();
}
function syncWorkFields() {
  const selected = [...$("#orderForm").querySelectorAll('input[name="types"]:checked')].map(input => input.value);
  for (const type of CONTENT_TYPES) {
    const row = $("#" + WORK_FIELDS[type][2]), active = selected.includes(type);
    row.hidden = !active; row.classList.toggle("work-single", selected.length === 1);
    row.querySelectorAll("input, select").forEach(input => { input.disabled = !active; });
  }
}
function openDialog(order = null) {
  if (!currentCohort) return openCohortDialog(true);
  editingId = order?.id ?? null;
  const form = $("#orderForm"); form.reset();
  renderWechatChoices(order?.wechat || (WECHATS.includes(entryDefaults.wechat) ? entryDefaults.wechat : WECHATS[0]));
  form.elements.code.value = order?.code || ""; form.elements.date.value = order?.date || today();
  form.elements.title.value = order?.title || "";
  renderContentChoices(order?.types || (Array.isArray(entryDefaults.types) ? entryDefaults.types : []));
  for (const field of ["deposit", "tail", "extra", "paid", "receivable"]) {
    form.elements[field].value = order ? amountText(order[field + "Cents"]) : "";
  }
  for (const type of CONTENT_TYPES) {
    const item = order ? workItem(order, type) : null, [memberField, costField] = WORK_FIELDS[type];
    const selected = item?.member || "";
    const names = [...new Set([...knownMembers(), ...(selected ? [selected] : [])])];
    form.elements[memberField].replaceChildren(makeOption("未分配", "", !selected), ...names.map(name => makeOption(name, name, name === selected)));
    form.elements[costField].value = item ? amountText(item.costCents) : "";
  }
  form.elements.legacyMemberCost.value = order?.unallocatedMemberCostCents ? amountText(order.unallocatedMemberCostCents) : "";
  $("#legacyWorkFields").hidden = !order?.unallocatedMemberCostCents; syncWorkFields();
  $("#priceDetails").open = false;
  $("#dialogTitle").textContent = (order ? "编辑订单" : "新建订单") + " · " + (order?.cohort || currentCohort);
  $("#formError").hidden = true; updatePreview(); $("#orderDialog").showModal(); form.elements[order ? "title" : "code"].focus();
}
function breakdownCents(form) {
  const parts = ["deposit", "tail", "extra"].map((field) => parseMoney(form.elements[field].value || "0"));
  return parts.every((value) => value !== null) ? parts.reduce((sum, value) => sum + value, 0) : null;
}
function updatePreview() {
  syncWorkFields();
  const form = $("#orderForm"), total = parseMoney(form.elements.receivable.value), paid = parseMoney(form.elements.paid.value || "0");
  const breakdown = breakdownCents(form); $("#totalPreview").textContent = breakdown === null ? "--" : money(breakdown);
  $("#balancePreview").textContent = total !== null && paid !== null ? money(Math.max(total - paid, 0)) : "--";
  const costs = [...form.querySelectorAll('input[name="types"]:checked')].map(input => parseMoney(form.elements[WORK_FIELDS[input.value][1]].value || "0"));
  costs.push(parseMoney(form.elements.legacyMemberCost.value || "0"));
  const memberCost = costs.every(value => value !== null) ? costs.reduce((sum, value) => sum + value, 0) : null;
  $("#memberCostTotal").textContent = memberCost !== null ? money(memberCost) : "--";
  const profit = total !== null && memberCost !== null ? total - memberCost : null;
  $("#profitPreview").textContent = profit !== null ? money(profit) : "--";
  $("#profitPreview").classList.toggle("loss", profit !== null && profit < 0);
}
function formError(message, field) {
  $("#formError").textContent = message; $("#formError").hidden = false; field?.focus();
}
function submitOrder(event) {
  event.preventDefault(); if (!currentCohort) return openCohortDialog(true);
  const fields = event.currentTarget.elements, previous = orders.find((order) => order.id === editingId);
  const cohort = previous?.cohort || currentCohort, code = fields.code.value.trim(), title = fields.title.value.trim();
  const types = [...event.currentTarget.querySelectorAll('input[name="types"]:checked')].map((input) => input.value);
  if (!WECHATS.includes(fields.wechat.value)) return formError("请选择接单微信。", event.currentTarget.querySelector('[name="wechat"]'));
  if (!code || code.length > 40) return formError("请填写 40 字以内的订单编号。", fields.code);
  if (orders.some((order) => order.id !== editingId && order.cohort === cohort &&
    order.code.toLocaleLowerCase("zh-CN") === code.toLocaleLowerCase("zh-CN"))) return formError("当前年级已有这个编号。", fields.code);
  if (!validDate(fields.date.value)) return formError("请选择有效的接单日期。", fields.date);
  if (!title || title.length > 150) return formError("请填写项目题目，最多 150 字。", fields.title);
  if (!types.length) return formError("请选择实物或论文。", event.currentTarget.querySelector('[name="types"]'));
  const receivableCents = parseMoney(fields.receivable.value), paidCents = parseMoney(fields.paid.value || "0");
  if (receivableCents === null || receivableCents <= 0) return formError("应收金额需大于 0，最多两位小数。", fields.receivable);
  if (paidCents === null) return formError("已收金额需为 0 或更大的数字，最多两位小数。", fields.paid);
  const workItems = [];
  for (const type of types) {
    const [memberField, costField] = WORK_FIELDS[type], member = fields[memberField].value.trim();
    if (member.length > 100) return formError(type + "成员姓名最多 100 字。", fields[memberField]);
    const costCents = parseMoney(fields[costField].value || "0");
    if (costCents === null) return formError(type + "费用需为 0 或更大的数字，最多两位小数。", fields[costField]);
    workItems.push({ type, member, costCents });
  }
  const unallocatedMemberCostCents = parseMoney(fields.legacyMemberCost.value || "0");
  if (unallocatedMemberCostCents === null) return formError("原成员费用金额有误。", fields.legacyMemberCost);
  const memberCostCents = workItems.reduce((sum, item) => sum + item.costCents, unallocatedMemberCostCents);
  if (memberCostCents > MAX_CENTS) return formError("成员费用合计超出可记录范围。", fields[WORK_FIELDS[types[0]][1]]);
  const parts = ["deposit", "tail", "extra"].map((field) => parseMoney(fields[field].value || "0"));
  if (parts.some((value) => value === null)) {
    $("#priceDetails").open = true; return formError("费用明细请填写有效金额，最多两位小数。", fields.deposit);
  }
  const payments = [...(previous?.payments || [])], beforePaid = previous?.paidCents || 0;
  if (paidCents !== beforePaid) payments.push(makePaymentEntry(paidCents - beforePaid, paidCents,
    previous ? "adjustment" : "opening", today(), previous ? "编辑修正" : "录入已收"));
  const item = { id: editingId || crypto.randomUUID(), cohort, date: fields.date.value, wechat: fields.wechat.value,
    code, title, types, ...(previous?.assignee ? { assignee: previous.assignee } : {}), depositCents: parts[0], tailCents: parts[1], extraCents: parts[2],
    receivableCents, paidCents, memberCostCents, workItems, unallocatedMemberCostCents, payments };
  const next = previous ? orders.map((order) => order.id === editingId ? item : order) : [...orders, item];
  if (saveOrders(next)) {
    entryDefaults = { wechat: item.wechat, types: item.types };
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(entryDefaults)); } catch {}
    $("#orderDialog").close(); showToast(previous ? "订单已更新" : "订单已保存");
  }
}
function openPaymentDialog(order, mode = "receipt") {
  paymentEditingId = order.id; $("#paymentOrderCode").textContent = order.code; $("#paymentOrderTitle").textContent = order.title;
  $("#paymentReceivable").textContent = money(totalCents(order)); $("#paymentCurrentPaid").textContent = money(order.paidCents);
  $("#paymentCurrentDue").textContent = money(dueCents(order));
  const form = $("#paymentForm"); form.reset(); form.elements.date.value = today();
  $("#paymentHistory").open = false; renderPaymentHistory(order); setPaymentMode(mode);
  $("#paymentDialog").showModal(); form.elements.amount.focus(); if (mode === "adjustment") form.elements.amount.select();
}
function setPaymentMode(mode) {
  const order = orders.find((item) => item.id === paymentEditingId); if (!order) return;
  paymentMode = mode; const adjusting = mode === "adjustment";
  $("#receiptMode").setAttribute("aria-pressed", String(!adjusting)); $("#adjustmentMode").setAttribute("aria-pressed", String(adjusting));
  $("#paymentAmountLabel").textContent = adjusting ? "累计已收（元）" : "本次到账（元）";
  $("#paymentDateLabel").textContent = adjusting ? "修改日期" : "到账日期"; $("#savePayment").textContent = adjusting ? "保存修改" : "保存收款";
  $("#fillRemaining").textContent = adjusting ? "填为应收金额" : "填入待收金额"; $("#fillRemaining").disabled = !adjusting && dueCents(order) === 0;
  $("#paymentForm").elements.amount.value = adjusting ? amountText(order.paidCents) : "";
  $("#paymentError").hidden = true; updatePaymentPreview();
}
function prospectivePaid(order, amount) { return paymentMode === "adjustment" ? amount : order.paidCents + amount; }
function updatePaymentPreview() {
  const order = orders.find((item) => item.id === paymentEditingId), amount = parseMoney($("#paymentForm").elements.amount.value);
  const paid = order && amount !== null ? prospectivePaid(order, amount) : null, valid = paid !== null && paid <= MAX_CENTS;
  $("#paymentPaidPreview").textContent = valid ? money(paid) : "--";
  $("#paymentBalancePreview").textContent = valid ? money(Math.max(totalCents(order) - paid, 0)) : "--";
}
function paymentError(message, field) {
  $("#paymentError").textContent = message; $("#paymentError").hidden = false; field?.focus();
}
function submitPayment(event) {
  event.preventDefault(); const order = orders.find((item) => item.id === paymentEditingId);
  if (!order) return $("#paymentDialog").close();
  const fields = event.currentTarget.elements, amount = parseMoney(fields.amount.value);
  if (amount === null || (paymentMode === "receipt" && amount === 0)) {
    return paymentError(paymentMode === "receipt" ? "本次到账需大于 0，最多两位小数。" : "累计已收需为 0 或更大的数字，最多两位小数。", fields.amount);
  }
  if (!validDate(fields.date.value)) return paymentError("请选择有效日期。", fields.date);
  const paidCents = prospectivePaid(order, amount);
  if (paidCents > MAX_CENTS) return paymentError("累计已收金额超出可记录范围。", fields.amount);
  if (paidCents === order.paidCents) { $("#paymentDialog").close(); showToast("已收金额未变"); return; }
  const entry = makePaymentEntry(paidCents - order.paidCents, paidCents, paymentMode, fields.date.value, fields.note.value.trim());
  const next = orders.map((item) => item.id === order.id ? { ...item, paidCents, payments: [...item.payments, entry] } : item);
  if (saveOrders(next)) {
    $("#paymentDialog").close(); showToast(paymentMode === "receipt" ? "收款已记录，累计已收 " + money(paidCents) : "已收金额已修正");
  }
}
function renderPaymentHistory(order) {
  $("#paymentHistoryTitle").textContent = "收款记录（" + order.payments.length + "）";
  const body = $("#paymentHistoryBody"); body.replaceChildren();
  if (!order.payments.length) { body.append(span("暂无收款记录", "history-empty")); return; }
  for (const entry of [...order.payments].reverse()) {
    const item = document.createElement("div"); item.className = "history-entry";
    const info = document.createElement("div"), kind = ({ opening: "初始已收", receipt: "收款", adjustment: "修正" })[entry.kind];
    info.append(span(entry.date || "历史余额", "history-date"), span(kind + (entry.note ? " · " + entry.note : ""), "history-note"));
    const amounts = document.createElement("div"); amounts.className = "history-amounts";
    amounts.append(span((entry.amountCents < 0 ? "−" : "+") + money(Math.abs(entry.amountCents)), "history-delta"),
      span("累计 " + money(entry.paidAfterCents), "history-running"));
    item.append(info, amounts); body.append(item);
  }
}
function deleteOrder(order) {
  if (!confirm("确认删除订单 " + order.code + "？删除后只能通过备份恢复。")) return;
  if (saveOrders(orders.filter((item) => item.id !== order.id))) showToast("订单已删除");
}
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(value) {
  let text = String(value); if (/^\s*[=+\-@]/.test(text) && !/^-\d+(?:\.\d+)?$/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function exportCsv() {
  const items = visibleOrders();
  const header = ["毕业年级", "接单日期", "接单微信", "订单编号", "项目题目", "制作内容",
    "实物成员", "实物成员费用(元)", "论文成员", "论文成员费用(元)", "待拆分成员费用(元)",
    "应收(元)", "已收(元)", "待收(元)", "成员结算费用(元)", "利润(元)", "状态", "定金明细(元)", "尾款明细(元)", "额外费用明细(元)", "收款记录"];
  const rows = items.map((order) => [order.cohort, order.date, order.wechat, order.code, order.title, order.types.join("、"),
    workItem(order, "实物")?.member || "", workItem(order, "实物") ? amountText(workItem(order, "实物").costCents) : "",
    workItem(order, "论文")?.member || "", workItem(order, "论文") ? amountText(workItem(order, "论文").costCents) : "",
    amountText(order.unallocatedMemberCostCents),
    amountText(totalCents(order)), amountText(order.paidCents), amountText(dueCents(order)),
    amountText(order.memberCostCents), amountText(profitCents(order)), paymentLabel(paymentState(order)),
    amountText(order.depositCents), amountText(order.tailCents), amountText(order.extraCents),
    order.payments.map((entry) => (entry.date || "历史余额") + " " + amountText(entry.amountCents) +
      "，累计 " + amountText(entry.paidAfterCents) + (entry.note ? "，" + entry.note : "")).join("\n")]);
  download("订单账本_" + (currentCohort || "全部") + "_" + today() + ".csv",
    "\ufeff" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  showToast("已导出当前列表 " + items.length + " 笔订单");
}
function exportJson() {
  if (!dataReady) return showToast("已有数据无法读取，请先恢复有效备份。");
  download("毕业设计订单备份_" + today() + ".json",
    JSON.stringify({ version: DATA_VERSION, exportedAt: new Date().toISOString(), currentCohort, members, orders }, null, 2), "application/json;charset=utf-8");
  showToast("已备份全部 " + orders.length + " 笔订单及收款记录");
}
async function importJson(event) {
  const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return;
  if (file.size > 20 * 1024 * 1024) return showToast("备份文件超过 20 MB，无法导入。");
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.orders) || (data.version && data.version > DATA_VERSION)) throw new Error("invalid");
    const imported = data.orders.map(normalizeOrder); if (!validateCollection(imported)) throw new Error("invalid");
    if (data.members !== undefined && !validMembers(data.members)) throw new Error("invalid");
    const importedMembers = [...new Set([...members, ...(data.members || [])])];
    if (!confirm("将用备份中的 " + imported.length + " 笔订单替换当前 " + orders.length + " 笔订单，确认恢复吗？")) return;
    if (saveOrders(imported, true, importedMembers)) {
      if (COHORTS.includes(data.currentCohort)) saveCurrentCohort(data.currentCohort);
      clearFilters(); render(); $("#cohortDialog").close(); showToast("已恢复 " + imported.length + " 笔订单及收款记录");
    }
  } catch { showToast("备份格式有误，未修改当前账本。"); }
}
let previousAiQuery = null;
function loadAiConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || "{}");
    if (typeof saved?.apiKey === "string" && saved.apiKey) aiConfig = LedgerAI.cleanConfig(saved);
    else aiConfig = { apiKey: "", model: LedgerAI.MODELS.includes(saved?.model) ? saved.model : "deepseek-flash" };
  } catch { aiConfig = { apiKey: "", model: "deepseek-flash" }; }
}
function aiError(message) { $("#aiError").textContent = message; $("#aiError").hidden = false; }
function aiStatus(message) { $("#aiStatus").textContent = message; $("#aiStatus").hidden = !message; }
function updateAiSettingsTitle() {
  $("#aiSettingsTitle").textContent = aiConfig.apiKey ? "DeepSeek · 修改密钥" : "DeepSeek · 首次填写 API Key";
}
function openAiDialog() {
  if (!currentCohort) return openCohortDialog(true);
  if (!dataReady) return showToast("请先恢复有效备份，再查询账本。");
  $("#aiDialogTitle").textContent = "AI 问账本";
  $("#aiApiKey").value = aiConfig.apiKey; $("#aiModel").value = aiConfig.model;
  $("#aiScope").options[0].textContent = "当前年级 · " + currentCohort;
  $("#aiSettings").open = !aiConfig.apiKey; $("#aiError").hidden = true; aiStatus(""); updateAiSettingsTitle();
  $("#aiDialog").showModal(); (aiConfig.apiKey ? $("#aiQuestion") : $("#aiApiKey")).focus();
}
function readAiSettings() { return LedgerAI.cleanConfig({ apiKey: $("#aiApiKey").value, model: $("#aiModel").value }); }
function saveAiSettings(notify = true) {
  try {
    const config = readAiSettings(); localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
    aiConfig = config; updateAiSettingsTitle(); $("#aiError").hidden = true;
    if (notify) { $("#aiSettings").open = false; aiStatus("密钥已保存在这台设备，以后打开直接使用。"); }
    return config;
  } catch (error) {
    aiError(error.code ? error.message : "设置保存失败，请检查浏览器是否允许本地存储。");
    $("#aiSettings").open = true; return null;
  }
}
function clearAiKey() {
  try {
    localStorage.removeItem(AI_CONFIG_KEY); aiConfig = { apiKey: "", model: "deepseek-flash" };
    $("#aiApiKey").value = ""; $("#aiModel").value = aiConfig.model;
    updateAiSettingsTitle(); $("#aiError").hidden = true; aiStatus("密钥已清除。");
  } catch { aiError("密钥清除失败，请重试。"); }
}
function setAiBusy(busy, mode = "query") {
  $("#aiQuestionForm").setAttribute("aria-busy", String(busy)); $("#aiQuestion").readOnly = busy;
  for (const id of ["aiApiKey", "aiModel", "aiScope", "aiTestConnection", "aiSaveSettings", "aiClearKey", "aiAsk"]) $("#" + id).disabled = busy;
  $("#aiExamples").querySelectorAll("button").forEach(button => { button.disabled = busy; });
  $("#aiAsk").textContent = busy && mode === "query" ? "正在查询…" : "询问账本";
  $("#aiTestConnection").textContent = busy && mode === "connection" ? "正在测试…" : "测试连接";
}
function cancelAiRequest() { aiRequestController?.abort(); aiRequestController = null; setAiBusy(false); }
async function testAiConnection() {
  if (aiRequestController) return;
  let config;
  try { config = readAiSettings(); } catch (error) { aiError(error.message); $("#aiApiKey").focus(); return; }
  const controller = new AbortController(); aiRequestController = controller;
  $("#aiError").hidden = true; setAiBusy(true, "connection"); aiStatus("正在连接 DeepSeek…");
  try {
    await LedgerAI.testConnection(config, { signal: controller.signal });
    if (!controller.signal.aborted && $("#aiDialog").open) aiStatus("连接成功，当前模型可用。");
  } catch (error) {
    if (!controller.signal.aborted && $("#aiDialog").open) { aiStatus(""); aiError(error.message); }
  } finally {
    if (aiRequestController === controller) { aiRequestController = null; setAiBusy(false); }
  }
}
function renderAiAnswer(question, report) {
  const answer = $("#aiAnswer"), title = document.createElement("h3");
  title.textContent = question; title.tabIndex = -1;
  const scope = document.createElement("p"); scope.className = "query-scope"; scope.textContent = report.title;
  const paragraphs = report.paragraphs.map(text => { const p = document.createElement("p"); p.textContent = text; return p; });
  answer.replaceChildren(title, scope, ...paragraphs);
  if (report.headers.length) {
    const wrap = document.createElement("div"); wrap.className = "query-table" + (report.headers.length > 5 ? " wide" : "");
    const table = document.createElement("table"), head = document.createElement("thead"), headerRow = document.createElement("tr"), body = document.createElement("tbody");
    report.headers.forEach(label => { const th = document.createElement("th"); th.scope = "col"; th.textContent = label; headerRow.append(th); });
    head.append(headerRow);
    report.rows.forEach(values => { const row = document.createElement("tr"); values.forEach(value => { const td = document.createElement("td"); td.textContent = value; row.append(td); }); body.append(row); });
    table.append(head, body); wrap.append(table); answer.append(wrap);
  }
  answer.hidden = false; title.focus();
}
async function askLedger(event) {
  event.preventDefault(); if (aiRequestController) return;
  const question = $("#aiQuestion").value.trim();
  if (!question) { aiError("请填写你要询问的账本问题。"); $("#aiQuestion").focus(); return; }
  if (question.length > 2000) { aiError("问题过长，请控制在 2000 字以内。"); return; }
  const config = saveAiSettings(false); if (!config) return;
  $("#aiSettings").open = false;
  const context = { date: today(), cohort: currentCohort, scope: $("#aiScope").value, cohorts: COHORTS, wechats: WECHATS,
    members: knownMembers(), previousQuery: previousAiQuery };
  const snapshot = JSON.parse(JSON.stringify(orders));
  const controller = new AbortController(); aiRequestController = controller;
  $("#aiError").hidden = true; $("#aiAnswer").hidden = true; setAiBusy(true); aiStatus("正在查询账本…");
  try {
    const query = await LedgerAI.requestQuery(config, context, question, { signal: controller.signal });
    if (controller.signal.aborted || !$("#aiDialog").open) return;
    const report = LedgerQuery.runQuery(snapshot, query, context.cohort);
    previousAiQuery = query; aiStatus(""); renderAiAnswer(question, report);
  } catch (error) {
    if (!controller.signal.aborted && $("#aiDialog").open) { aiStatus(""); aiError(error.message); }
  } finally {
    if (aiRequestController === controller) { aiRequestController = null; setAiBusy(false); }
  }
}
function initialize() {
  $("#addOrder").addEventListener("click", () => openDialog()); $("#emptyAdd").addEventListener("click", () => openDialog());
  $("#switchCohort").addEventListener("click", () => openCohortDialog(false)); $("#cohortSetupForm").addEventListener("submit", submitCohort);
  $("#cancelCohort").addEventListener("click", () => $("#cohortDialog").close());
  $("#manageMembers").addEventListener("click", openMembersDialog); $("#manageOrderMembers").addEventListener("click", openMembersDialog);
  $("#memberForm").addEventListener("submit", submitMember);
  $("#closeMembersDialog").addEventListener("click", () => $("#membersDialog").close()); $("#doneMembers").addEventListener("click", () => $("#membersDialog").close());
  $("#closeDialog").addEventListener("click", () => $("#orderDialog").close()); $("#cancelDialog").addEventListener("click", () => $("#orderDialog").close());
  $("#orderForm").addEventListener("submit", submitOrder); $("#orderForm").addEventListener("input", updatePreview); $("#orderForm").addEventListener("change", updatePreview);
  $("#clearLegacyCost").addEventListener("click", () => { $("#orderForm").elements.legacyMemberCost.value = ""; updatePreview(); });
  $("#applyBreakdown").addEventListener("click", () => {
    const total = breakdownCents($("#orderForm"));
    if (total === null || total <= 0 || total > MAX_CENTS) return formError("请先填写有效的费用明细。", $("#orderForm").elements.deposit);
    $("#orderForm").elements.receivable.value = amountText(total); $("#formError").hidden = true; updatePreview();
  });
  $("#closePaymentDialog").addEventListener("click", () => $("#paymentDialog").close());
  $("#cancelPaymentDialog").addEventListener("click", () => $("#paymentDialog").close());
  $("#receiptMode").addEventListener("click", () => setPaymentMode("receipt")); $("#adjustmentMode").addEventListener("click", () => setPaymentMode("adjustment"));
  $("#paymentForm").addEventListener("submit", submitPayment); $("#paymentForm").addEventListener("input", updatePaymentPreview);
  $("#fillRemaining").addEventListener("click", () => {
    const order = orders.find((item) => item.id === paymentEditingId); if (!order) return;
    $("#paymentForm").elements.amount.value = amountText(paymentMode === "receipt" ? dueCents(order) : totalCents(order));
    $("#paymentError").hidden = true; updatePaymentPreview();
  });
  $("#searchInput").addEventListener("input", render);
  for (const id of ["wechatFilter", "workerFilter", "paymentFilter"]) $("#" + id).addEventListener("change", render);
  $("#clearFilters").addEventListener("click", () => { clearFilters(); render(); });
  $("#exportCsv").addEventListener("click", exportCsv); $("#exportJson").addEventListener("click", exportJson);
  $("#importButton").addEventListener("click", () => $("#importFile").click()); $("#importFile").addEventListener("change", importJson);
  $("#aiAskLedger").addEventListener("click", openAiDialog); $("#aiQuestionForm").addEventListener("submit", askLedger);
  $("#aiSaveSettings").addEventListener("click", () => saveAiSettings()); $("#aiClearKey").addEventListener("click", clearAiKey);
  $("#aiTestConnection").addEventListener("click", testAiConnection);
  $("#closeAiDialog").addEventListener("click", () => $("#aiDialog").close()); $("#aiCancel").addEventListener("click", () => $("#aiDialog").close());
  $("#aiDialog").addEventListener("close", cancelAiRequest); $("#aiDialog").addEventListener("cancel", cancelAiRequest);
  fillSelect($("#cohortSelect"), COHORTS, "23级"); renderContentChoices([]); loadOrders(); loadPreferences(); render();
  $("#aiScope").addEventListener("change", () => { previousAiQuery = null; $("#aiAnswer").hidden = true; });
  $("#aiExamples").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    $("#aiQuestion").value = button.dataset.question; $("#aiQuestionForm").requestSubmit();
  }));
  $("#aiQuestion").addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $("#aiQuestionForm").requestSubmit(); }
  });
  loadAiConfig();
  if (!currentCohort) setTimeout(() => openCohortDialog(true), 0);
}
initialize();
