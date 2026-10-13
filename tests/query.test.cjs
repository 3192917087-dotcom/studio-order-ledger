"use strict";
const assert = require("node:assert/strict");
const AI = require("../deepseek.js"), Query = require("../ledger-query.js");
const config = { apiKey: "test-key-not-a-real-credential", model: "deepseek-flash" };
const context = { date: "2026-10-13", cohort: "23级", scope: "current", cohorts: ["22级", "23级"], wechats: ["微信1", "微信2", "微信3", "微信4"], members: ["张三", "李四"] };
const plan = options => Query.normalizeQuery({ intent: "summary", ...options }, context);
const order = (id, values = {}) => ({ id, cohort: "23级", wechat: "微信1", code: "23" + id, title: "智能温控" + id,
  date: "2026-10-13", types: ["实物", "论文"], receivableCents: 100000, paidCents: 20000, memberCostCents: 40000,
  workItems: [{ type: "实物", member: "张三", costCents: 25000 }, { type: "论文", member: "李四", costCents: 15000 }], unallocatedMemberCostCents: 0,
  payments: [{ id: "p" + id, kind: "opening", date: "2026-10-13", amountCents: 20000, paidAfterCents: 20000, note: "" }], ...values });
const orders = [order("001"), order("002", { wechat: "微信2", paidCents: 120000 }), order("003", { cohort: "22级", code: "22003", date: "2025-10-13" })];
const response = data => ({ ok: true, json: async () => data });
const completion = (content, finish_reason = "stop") => response({ choices: [{ message: { content }, finish_reason }] });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log("PASS " + name); }
(async () => {
  await test("当前年级、跨年级和按微信汇总，超收不抵消其他订单尾款", () => {
    const current = Query.runQuery(orders, plan({}), "23级"); assert.equal(current.count, 2);
    assert.deepEqual(current.totals, { receivable: 200000, paid: 140000, due: 80000, cost: 80000, profit: 120000 });
    assert.equal(Query.runQuery(orders, plan({ scope: "all" }), "23级").count, 3);
    assert.equal(Query.runQuery(orders, plan({ cohort: "22级" }), "23级").count, 1);
    assert.equal(Query.runQuery(orders, plan({ wechat: "微信1" }), "23级").totals.profit, 60000);
  });
  await test("精确编号、题目、日期、已结清和未结清筛选", () => {
    assert.equal(Query.runQuery(orders, plan({ code: "23001" }), "23级").count, 1);
    assert.equal(Query.runQuery(orders, plan({ code: "2300" }), "23级").count, 0);
    assert.equal(Query.runQuery(orders, plan({ status: "paid" }), "23级").count, 1);
    assert.equal(Query.runQuery(orders, plan({ status: "due" }), "23级").count, 1);
    assert.equal(Query.runQuery(orders, plan({ scope: "all", startDate: "2026-01-01" }), "23级").count, 2);
    assert.equal(Query.runQuery(orders, plan({ search: "温控001" }), "23级").count, 1);
  });
  await test("实物和论文匹配对应的成员，费用不会串到另一个任务", () => {
    assert.equal(Query.runQuery(orders, plan({ member: "张三", types: ["论文"] }), "23级").count, 0);
    assert.equal(Query.runQuery(orders, plan({ member: "张三", types: ["实物"], focus: "cost" }), "23级").totals.cost, 50000);
    assert.equal(Query.runQuery(orders, plan({ member: "李四", focus: "cost" }), "23级").totals.cost, 30000);
  });
  await test("两项同一个成员时订单数只计一次，费用计两项", () => {
    const same = order("004", { workItems: [{ type: "实物", member: "张三", costCents: 25000 }, { type: "论文", member: "张三", costCents: 15000 }] });
    const report = Query.runQuery([same], plan({ intent: "group", groupBy: "member", focus: "cost" }), "23级");
    assert.deepEqual(report.rows[0], ["张三", "1", "¥250.00", "¥150.00", "¥400.00"]);
  });
  await test("旧费用显示待拆分，不猜测属于实物或论文", () => {
    const legacy = order("005", { workItems: [{ type: "实物", member: "", costCents: 0 }, { type: "论文", member: "", costCents: 0 }], unallocatedMemberCostCents: 40000 });
    const report = Query.runQuery([legacy], plan({ intent: "group", groupBy: "member", focus: "cost" }), "23级");
    assert(report.rows.some(row => row[0] === "待拆分（旧费用）" && row[4] === "¥400.00"));
  });
  await test("制作内容、年级和微信分组，不虚构个人利润", () => {
    assert.deepEqual(Query.runQuery(orders, plan({ intent: "group", groupBy: "type" }), "23级").rows, [["实物", "2", "¥500.00"], ["论文", "2", "¥300.00"]]);
    assert.equal(Query.runQuery(orders, plan({ intent: "group", groupBy: "cohort", scope: "all" }), "23级").rows.length, 2);
    assert.equal(Query.runQuery(orders, plan({ intent: "group", groupBy: "wechat" }), "23级").rows.length, 2);
    assert(Query.runQuery(orders, plan({ focus: "profit", types: ["论文"] }), "23级").paragraphs[0].includes("无法拆分"));
  });
  await test("列表限制仅影响显示，汇总覆盖全部匹配订单；收款历史只读", () => {
    const before = JSON.stringify(orders);
    const report = Query.runQuery(orders, plan({ intent: "list", status: "due", limit: 1, scope: "all", sort: "dueDesc" }), "23级");
    assert.equal(report.count, 2); assert.equal(report.rows.length, 1); assert.equal(report.totals.due, 160000);
    assert(report.paragraphs.some(text => text.includes("全部匹配订单")));
    assert.equal(Query.runQuery(orders, plan({ intent: "history", code: "23001" }), "23级").rows[0][3], "¥200.00");
    assert.equal(JSON.stringify(orders), before);
  });
  await test("未知人员、无效日期、写入动作和畸形查询被拒绝", () => {
    for (const input of [{ member: "不存在" }, { receiver: "成员1" }, { groupBy: "receiver" }, { wechat: "其他微信" }, { cohort: "99级" }, { intent: "delete" },
      { startDate: "2026-02-30" }, { startDate: "2026-10-14", endDate: "2026-10-13" }, { limit: 500 }, { types: ["unknown"] }]) assert.throws(() => plan(input));
  });
  await test("只发送问题和选项，不发送订单金额、完整订单和密钥正文", async () => {
    let sent;
    const query = await AI.requestQuery(config, context, "这个年级赚了多少？", { fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) }; return completion(JSON.stringify({ intent: "summary", focus: "profit" }));
    } });
    assert.equal(query.focus, "profit"); assert.equal(sent.url, "https://api.deepseek.com/chat/completions");
    assert.equal(sent.options.headers.Authorization, "Bearer " + config.apiKey); assert.equal(sent.options.redirect, "error");
    assert.equal(sent.body.response_format.type, "json_object"); assert.equal(sent.body.thinking.type, "disabled");
    const body = JSON.stringify(sent.body); assert(!body.includes(config.apiKey)); assert(!body.includes("receivableCents")); assert(!body.includes("payments"));
    assert(!body.includes('"receiver"')); assert(!body.includes('"receivers"'));
  });
  await test("缺少问题或密钥不发请求，空响应和截断 JSON 不产生账目答案", async () => {
    const neverFetch = async () => { throw new Error("不应该调用网络"); };
    await assert.rejects(AI.requestQuery(config, context, "", { fetchImpl: neverFetch }));
    await assert.rejects(AI.requestQuery({ ...config, apiKey: "" }, context, "问题", { fetchImpl: neverFetch }));
    for (const raw of ["", "{", "[]"]) await assert.rejects(AI.requestQuery(config, context, "问题", { fetchImpl: async () => completion(raw) }));
    await assert.rejects(AI.requestQuery(config, context, "问题", { fetchImpl: async () => completion("{}", "length") }));
  });
  await test("服务错误有明确提示，错误内容不泄露密钥", async () => {
    for (const [status, text] of [[401, "API Key 无效"], [402, "余额不足"], [429, "过于频繁"], [500, "暂时不可用"]]) {
      await assert.rejects(AI.requestQuery(config, context, "问题", { fetchImpl: async () => ({ ok: false, status }) }), error => error.message.includes(text) && !error.message.includes(config.apiKey));
    }
    await assert.rejects(AI.requestQuery(config, context, "问题", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), /检查网络/);
  });
  await test("连接测试、取消和超时可结束", async () => {
    assert.equal(await AI.testConnection(config, { fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/models"); assert.equal(options.method, "GET"); return response({ data: [{ id: config.model }] });
    } }), true);
    const waitingFetch = async (url, options) => new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (options.signal.aborted) return abort(); options.signal.addEventListener("abort", abort, { once: true });
    });
    const controller = new AbortController(), pending = AI.requestQuery(config, context, "问题", { fetchImpl: waitingFetch, signal: controller.signal });
    controller.abort(); await assert.rejects(pending, error => error.code === "cancelled");
    await assert.rejects(AI.requestQuery(config, context, "问题", { fetchImpl: waitingFetch, timeoutMs: 5 }), error => error.code === "timeout");
  });
  console.log(`\n${passed} read-only ledger AI checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
