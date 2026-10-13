/* Queries are read-only. All totals are calculated from local ledger records. */
(function (root) {
  "use strict";
  const TYPES = ["实物", "论文"];
  const cash = cents => "¥" + (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function invalid(message) { const error = new Error(message); error.code = "query"; return error; }
  function text(value, max = 150) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || value.trim().length > max || /[\u0000-\u001f]/.test(value)) throw invalid("AI 未能理解查询条件，请换一种说法。");
    return value.trim() || null;
  }
  function date(value) {
    const valueText = text(value, 10); if (!valueText) return null;
    const parsed = new Date(valueText + "T00:00:00");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText) || Number.isNaN(parsed.getTime()) ||
      parsed.getFullYear() !== Number(valueText.slice(0, 4)) || parsed.getMonth() + 1 !== Number(valueText.slice(5, 7)) ||
      parsed.getDate() !== Number(valueText.slice(8))) throw invalid("查询日期无效，请明确开始和结束日期。");
    return valueText;
  }
  function normalizeQuery(source, context) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw invalid("AI 返回的查询格式有误，请重新询问。");
    if (source.receiver) throw invalid("请按实物成员或论文成员查询。");
    function choice(key, allowed, fallback) {
      const value = source[key] ?? fallback;
      if (!allowed.includes(value)) throw invalid("AI 未能理解查询条件，请换一种说法。");
      return value;
    }
    const query = {
      intent: choice("intent", ["summary", "list", "group", "history", "help"], null),
      scope: choice("scope", ["current", "all"], context.scope || "current"),
      groupBy: choice("groupBy", ["cohort", "wechat", "member", "type"], "cohort"),
      focus: choice("focus", ["all", "profit", "due", "paid", "receivable", "cost", "count"], "all"),
      status: choice("status", ["all", "due", "unpaid", "partial", "paid"], "all"),
      sort: choice("sort", ["dateDesc", "profitDesc", "profitAsc", "dueDesc", "costDesc"], "dateDesc"),
      cohort: text(source.cohort, 20), wechat: text(source.wechat, 100), member: text(source.member, 100),
      code: text(source.code, 40), search: text(source.search),
      startDate: date(source.startDate), endDate: date(source.endDate), clarification: text(source.clarification, 200),
      types: source.types ?? [], limit: source.limit ?? 20
    };
    if (query.cohort && !context.cohorts.includes(query.cohort)) throw invalid("账本中没有这个年级，请使用账本中的年级名称。");
    if (query.wechat && !context.wechats.includes(query.wechat)) throw invalid("未匹配到接单微信，请使用" + context.wechats.join("、") + "。");
    if (query.member && query.member !== "未分配" && !context.members.includes(query.member)) throw invalid("未找到制作成员“" + query.member + "”，请核对姓名。");
    if (!Array.isArray(query.types) || query.types.some(type => !TYPES.includes(type))) throw invalid("制作内容查询条件有误。");
    query.types = [...new Set(query.types)];
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50) throw invalid("一次最多显示 50 笔明细。");
    if (query.startDate && query.endDate && query.startDate > query.endDate) throw invalid("开始日期不能晚于结束日期。");
    return query;
  }
  const due = order => Math.max(order.receivableCents - order.paidCents, 0);
  const profit = order => order.receivableCents - order.memberCostCents;
  const state = order => order.paidCents >= order.receivableCents ? "paid" : (order.paidCents === 0 ? "unpaid" : "partial");
  function relevantWork(order, query) {
    return order.workItems.filter(item => (!query.types.length || query.types.includes(item.type)) &&
      (!query.member || (query.member === "未分配" ? !item.member : item.member === query.member)));
  }
  function selectOrders(orders, query, currentCohort) {
    const cohort = query.cohort || (query.scope === "current" ? currentCohort : null);
    return orders.filter(order => (!cohort || order.cohort === cohort) && (!query.wechat || order.wechat === query.wechat) &&
      (!query.code || order.code.toLocaleLowerCase("zh-CN") === query.code.toLocaleLowerCase("zh-CN")) &&
      (!query.search || [order.code, order.title].some(value => value.toLocaleLowerCase("zh-CN").includes(query.search.toLocaleLowerCase("zh-CN")))) &&
      (!query.startDate || order.date >= query.startDate) && (!query.endDate || order.date <= query.endDate) &&
      (query.status === "all" || (query.status === "due" ? due(order) > 0 : state(order) === query.status)) &&
      query.types.every(type => order.types.includes(type)) && (!query.member || relevantWork(order, query).length > 0));
  }
  function totalsFor(orders, query) {
    return orders.reduce((total, order) => {
      total.receivable += order.receivableCents; total.paid += order.paidCents; total.due += due(order);
      total.cost += query.types.length || query.member ? relevantWork(order, query).reduce((sum, item) => sum + item.costCents, 0) : order.memberCostCents;
      total.profit += profit(order); return total;
    }, { receivable: 0, paid: 0, due: 0, cost: 0, profit: 0 });
  }
  function queryTitle(query, currentCohort) {
    return [query.cohort || (query.scope === "all" ? "全部年级" : currentCohort), query.wechat,
      query.member && "制作成员：" + query.member,
      query.types.join("＋"), ({ due: "未结清", unpaid: "未收款", partial: "部分收款", paid: "已结清" })[query.status],
      query.code && "编号：" + query.code, query.search, query.startDate && "从 " + query.startDate,
      query.endDate && "至 " + query.endDate].filter(Boolean).join(" · ");
  }
  function runQuery(orders, query, currentCohort) {
    const selected = selectOrders(orders, query, currentCohort), totals = totalsFor(selected, query);
    const report = { title: queryTitle(query, currentCohort), paragraphs: [], headers: [], rows: [], count: selected.length, totals };
    if (query.clarification || query.intent === "help") {
      report.paragraphs.push(query.clarification || "可以询问利润、应收与已收、未结清订单、微信或年级汇总、成员费用及订单收款记录。"); return report;
    }
    if (query.focus === "profit" && (query.types.length || (query.intent === "group" && ["member", "type"].includes(query.groupBy)))) {
      report.paragraphs.push("实物与论文没有分别记录售价，无法拆分各项或各成员的利润。可以查询订单总利润或分别统计成员费用。"); return report;
    }
    if (!selected.length) { report.paragraphs.push("没有符合这些条件的订单。"); return report; }
    const labels = { profit: "利润", due: "待收金额", paid: "已收总额", receivable: "应收总额", cost: "成员费用", count: "订单数" };
    report.paragraphs.push("共 " + selected.length + " 笔订单" + (query.focus !== "all" ? "，" + labels[query.focus] + " " +
      (query.focus === "count" ? selected.length + " 笔" : cash(totals[query.focus])) : "") + "。");
    if (query.focus === "all") {
      report.paragraphs.push("应收 " + cash(totals.receivable) + "；已收 " + cash(totals.paid) + "；待收 " + cash(totals.due) + "。",
        "成员费用 " + cash(totals.cost) + "；订单利润 " + cash(totals.profit) + "。");
    }
    if (query.intent === "summary") return report;
    if (query.intent === "history") {
      if (selected.length !== 1) { report.paragraphs.push("请指定一个订单编号，再查询收款记录。"); return report; }
      const order = selected[0]; report.title += " · " + order.title;
      report.headers = ["日期", "类型", "金额变化", "累计已收", "备注"];
      report.rows = order.payments.slice(-query.limit).map(entry => [entry.date || "历史余额",
        ({ opening: "初始已收", receipt: "收款", adjustment: "修正" })[entry.kind], cash(entry.amountCents), cash(entry.paidAfterCents), entry.note]);
      report.paragraphs.push("共 " + order.payments.length + " 笔收款记录" + (order.payments.length > query.limit ? "，显示最近 " + query.limit + " 笔" : "") + "。");
      return report;
    }
    if (query.intent === "list") {
      const sorted = [...selected].sort((a, b) => {
        const delta = ({ profitDesc: profit(b) - profit(a), profitAsc: profit(a) - profit(b), dueDesc: due(b) - due(a), costDesc: b.memberCostCents - a.memberCostCents })[query.sort];
        return delta || b.date.localeCompare(a.date) || b.code.localeCompare(a.code, "zh-CN", { numeric: true });
      });
      const focus = ["profit", "paid", "receivable", "cost"].includes(query.focus) ? query.focus : "due";
      report.headers = ["编号", "题目", labels[focus], "制作成员"];
      report.rows = sorted.slice(0, query.limit).map(order => [order.code, order.title,
        cash(({ profit: profit(order), paid: order.paidCents, receivable: order.receivableCents, cost: order.memberCostCents, due: due(order) })[focus]),
        relevantWork(order, query).map(item => item.type + "：" + (item.member || "未分配")).join("；")]);
      if (selected.length > query.limit) report.paragraphs.push("显示前 " + query.limit + " 笔，汇总已包含全部匹配订单。");
      return report;
    }
    const groups = new Map();
    function feeGroup(key, order, item, legacy = false) {
      if (!groups.has(key)) groups.set(key, { ids: new Set(), physical: 0, paper: 0, legacy: 0 });
      const group = groups.get(key); group.ids.add(order.id);
      group[legacy ? "legacy" : (item.type === "实物" ? "physical" : "paper")] += legacy ? order.unallocatedMemberCostCents : item.costCents;
    }
    if (["member", "type"].includes(query.groupBy)) {
      for (const order of selected) {
        for (const item of relevantWork(order, query)) feeGroup(query.groupBy === "member" ? item.member || "未分配" : item.type, order, item);
        if (order.unallocatedMemberCostCents && !query.member) feeGroup("待拆分（旧费用）", order, null, true);
      }
      report.headers = query.groupBy === "member" ? ["成员", "订单数", "实物费用", "论文费用", "费用合计"] : ["制作内容", "订单数", "成员费用"];
      const ordered = [...groups].sort((a, b) => (b[1].physical + b[1].paper + b[1].legacy) - (a[1].physical + a[1].paper + a[1].legacy));
      report.rows = ordered.map(([name, group]) => query.groupBy === "member" ?
        [name, String(group.ids.size), cash(group.physical), cash(group.paper), cash(group.physical + group.paper + group.legacy)] :
        [name, String(group.ids.size), cash(group.physical + group.paper + group.legacy)]);
      return report;
    }
    for (const order of selected) {
      const key = ({ cohort: order.cohort, wechat: order.wechat })[query.groupBy];
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(order);
    }
    report.headers = [({ cohort: "年级", wechat: "微信" })[query.groupBy], "订单数", "应收", "已收", "待收", "成员费用", "利润"];
    report.rows = [...groups].sort((a, b) => totalsFor(b[1], query).profit - totalsFor(a[1], query).profit).map(([key, items]) => {
      const total = totalsFor(items, query); return [key, String(items.length), cash(total.receivable), cash(total.paid), cash(total.due), cash(total.cost), cash(total.profit)];
    });
    return report;
  }
  const api = Object.freeze({ normalizeQuery, runQuery, selectOrders });
  if (typeof module === "object" && module.exports) module.exports = api; else root.LedgerQuery = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
