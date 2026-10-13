/* A detached, read-only financial snapshot. Money is always calculated in cents. */
(function (root) {
  "use strict";
  const TYPES = ["实物", "论文"];
  const METRICS = ["orderCount", "receivableCents", "paidCents", "dueCents", "memberCostCents", "profitCents", "profitMarginPct", "ageDays"];
  const percent = (value, base) => base ? Math.round(value / base * 10000) / 100 : null;
  const days = (from, to) => from ? Math.floor((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) : null;
  const due = order => Math.max(order.receivableCents - order.paidCents, 0);
  const profit = order => order.receivableCents - order.memberCostCents;
  const status = order => order.paidCents >= order.receivableCents ? "paid" : order.paidCents === 0 ? "unpaid" : "partial";
  function error(message) { const e = new Error(message); e.code = "analysis"; return e; }
  function freeze(value) {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  function date(value) {
    if (value == null || value === "") return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + "T00:00:00Z")) || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) throw error("日期无效，请使用 YYYY-MM-DD。");
    return value;
  }
  function validateKeys(value, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw error("查询参数无效；只支持提供的只读查询字段。");
  }
  const FILTER_KEYS = ["cohort", "wechat", "member", "types", "code", "id", "search", "status", "startDate", "endDate",
    "receivableMinCents", "receivableMaxCents", "profitMinCents", "profitMaxCents", "dueMinCents", "dueMaxCents", "marginMinPct", "marginMaxPct"];
  function filters(source = {}) {
    validateKeys(source, FILTER_KEYS); const f = { ...source };
    for (const key of ["cohort", "wechat", "member", "code", "id", "search"]) {
      if (f[key] != null && (typeof f[key] !== "string" || f[key].length > 200 || /[\u0000-\u001f]/.test(f[key]))) throw error("文本查询条件无效。");
      f[key] = f[key]?.trim() || null;
    }
    f.types = f.types ?? [];
    if (!Array.isArray(f.types) || f.types.some(type => !TYPES.includes(type))) throw error("制作内容只能是实物或论文。");
    f.status = f.status || "all";
    if (!["all", "due", "unpaid", "partial", "paid"].includes(f.status)) throw error("收款状态无效。");
    f.startDate = date(f.startDate); f.endDate = date(f.endDate);
    if (f.startDate && f.endDate && f.startDate > f.endDate) throw error("开始日期不能晚于结束日期。");
    for (const key of FILTER_KEYS.filter(key => /Cents$|Pct$/.test(key))) {
      if (f[key] != null && (!Number.isFinite(f[key]) || (/Cents$/.test(key) && !Number.isSafeInteger(f[key])))) throw error("金额或比率筛选必须使用有效数字，金额单位为分。");
    }
    for (const prefix of ["receivable", "profit", "due", "margin"]) {
      const suffix = prefix === "margin" ? "Pct" : "Cents";
      if (f[prefix + "Min" + suffix] != null && f[prefix + "Max" + suffix] != null && f[prefix + "Min" + suffix] > f[prefix + "Max" + suffix]) throw error("筛选下限不能超过上限。");
    }
    return f;
  }
  function matchingWork(order, f) {
    return order.workItems.filter(item => (!f.types.length || f.types.includes(item.type)) && (!f.member || (f.member === "未分配" ? !item.member : item.member === f.member)));
  }
  function matches(order, f) {
    const margin = percent(profit(order), order.receivableCents);
    return (!f.cohort || order.cohort === f.cohort) && (!f.wechat || order.wechat === f.wechat) &&
      (!f.id || order.id === f.id) && (!f.code || order.code.toLowerCase() === f.code.toLowerCase()) &&
      (!f.search || (order.code + " " + order.title).toLowerCase().includes(f.search.toLowerCase())) &&
      (!f.startDate || order.date >= f.startDate) && (!f.endDate || order.date <= f.endDate) &&
      (f.status === "all" || (f.status === "due" ? due(order) > 0 : status(order) === f.status)) &&
      f.types.every(type => order.types.includes(type)) && (!f.member || matchingWork(order, f).length > 0) &&
      [["receivable", order.receivableCents, "Cents"], ["profit", profit(order), "Cents"], ["due", due(order), "Cents"], ["margin", margin, "Pct"]].every(([key, value, suffix]) =>
        (f[key + "Min" + suffix] == null || (value != null && value >= f[key + "Min" + suffix])) &&
        (f[key + "Max" + suffix] == null || (value != null && value <= f[key + "Max" + suffix])));
  }
  function totals(orders, f, today) {
    const t = { orderCount: orders.length, receivableCents: 0, paidCents: 0, dueCents: 0, overpaidCents: 0,
      memberCostCents: 0, matchedTaskCostCents: 0, unallocatedMemberCostCents: 0, profitCents: 0,
      settledOrderCount: 0, unpaidOrderCount: 0, partialOrderCount: 0, lossOrderCount: 0, zeroReceivableOrderCount: 0,
      unassignedTaskCount: 0, unknownWechatOrderCount: 0, negativeProfitCents: 0 };
    const aging = [0, 0, 0, 0, 0];
    for (const order of orders) {
      t.receivableCents += order.receivableCents; t.paidCents += order.paidCents; t.dueCents += due(order);
      t.overpaidCents += Math.max(order.paidCents - order.receivableCents, 0); t.memberCostCents += order.memberCostCents;
      t.matchedTaskCostCents += matchingWork(order, f).reduce((sum, item) => sum + item.costCents, 0);
      t.unallocatedMemberCostCents += order.unallocatedMemberCostCents; t.profitCents += profit(order);
      t[({ paid: "settledOrderCount", unpaid: "unpaidOrderCount", partial: "partialOrderCount" })[status(order)]]++;
      if (profit(order) < 0) { t.lossOrderCount++; t.negativeProfitCents += profit(order); }
      if (order.receivableCents === 0) t.zeroReceivableOrderCount++;
      t.unassignedTaskCount += order.workItems.filter(item => !item.member).length;
      if (!order.wechat) t.unknownWechatOrderCount++;
      const age = days(order.date, today);
      aging[age == null || age < 0 ? 4 : age <= 30 ? 0 : age <= 90 ? 1 : age <= 180 ? 2 : 3] += due(order);
    }
    return { ...t, profitMarginPct: percent(t.profitCents, t.receivableCents),
      collectionRatePct: percent(t.receivableCents - t.dueCents, t.receivableCents),
      paidToReceivablePct: percent(t.paidCents, t.receivableCents), memberCostRatePct: percent(t.memberCostCents, t.receivableCents),
      averageOrderReceivableCents: orders.length ? Math.round(t.receivableCents / orders.length) : null,
      averageOrderProfitCents: orders.length ? Math.round(t.profitCents / orders.length) : null,
      dueAgingByOrderDate: { "0至30天": aging[0], "31至90天": aging[1], "91至180天": aging[2], "超过180天": aging[3], "日期未知或在未来": aging[4] } };
  }
  function pageOptions(args, sortable) {
    const limit = args.limit ?? 50, offset = args.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw error("每页为 1 至 100 条，offset 为非负整数。");
    const sortBy = args.sortBy || sortable[0], direction = args.direction || "desc";
    if (!sortable.includes(sortBy) || !["asc", "desc"].includes(direction)) throw error("排序参数无效。");
    return { limit, offset, sortBy, direction };
  }
  function sorted(items, options) {
    return [...items].sort((a, b) => {
      const av = options.sortBy === "group" ? JSON.stringify(a.group) : a[options.sortBy], bv = options.sortBy === "group" ? JSON.stringify(b.group) : b[options.sortBy];
      const delta = typeof av === "string" ? av.localeCompare(bv || "", "zh-CN", { numeric: true }) : (av ?? -Infinity) - (bv ?? -Infinity);
      return (options.direction === "asc" ? delta : -delta) || String(a.id || JSON.stringify(a.group)).localeCompare(String(b.id || JSON.stringify(b.group)));
    });
  }
  function paged(items, options) {
    const page = []; let chars = 0;
    for (const item of items.slice(options.offset, options.offset + options.limit)) {
      const size = JSON.stringify(item).length;
      if (page.length && chars + size > 24000) break;
      if (size > 24000) throw error("单条查询结果过大，请缩小查询范围。");
      page.push(item); chars += size;
    }
    const next = options.offset + page.length;
    return { totalRows: items.length, offset: options.offset, returnedRows: page.length, hasMore: next < items.length,
      nextOffset: next < items.length ? next : null, rows: page };
  }
  function orderRow(order, today) {
    return { id: order.id, cohort: order.cohort, date: order.date, wechat: order.wechat, code: order.code, title: order.title,
      types: order.types, workItems: order.workItems, depositCents: order.depositCents, tailCents: order.tailCents, extraCents: order.extraCents,
      receivableCents: order.receivableCents, paidCents: order.paidCents, dueCents: due(order), memberCostCents: order.memberCostCents,
      unallocatedMemberCostCents: order.unallocatedMemberCostCents, profitCents: profit(order), profitMarginPct: percent(profit(order), order.receivableCents),
      status: status(order), ageDays: days(order.date, today), paymentHistoryCount: order.payments.length };
  }
  function createSnapshot(source, context) {
    const today = date(context.date);
    if (!today || !Array.isArray(source)) throw error("账本快照无效。");
    // Deliberate allowlist: no settings, API keys, or legacy assignee metadata enter the snapshot.
    const orders = freeze(source.map(order => ({
      id: order.id, cohort: order.cohort, date: order.date, wechat: order.wechat || "", code: order.code, title: order.title,
      types: [...order.types], workItems: order.workItems.map(item => ({ type: item.type, member: item.member, costCents: item.costCents })),
      depositCents: order.depositCents || 0, tailCents: order.tailCents || 0, extraCents: order.extraCents || 0,
      receivableCents: order.receivableCents, paidCents: order.paidCents, memberCostCents: order.memberCostCents,
      unallocatedMemberCostCents: order.unallocatedMemberCostCents || 0,
      payments: order.payments.map(p => ({ id: p.id, kind: p.kind, date: p.date || "", amountCents: p.amountCents, paidAfterCents: p.paidAfterCents, note: p.note || "" }))
    })));
    function report(args = {}) {
      validateKeys(args, ["filters", "groupBy", "limit", "offset", "sortBy", "direction"]);
      const f = filters(args.filters), selected = orders.filter(order => matches(order, f));
      const groupBy = args.groupBy ?? [];
      const allowed = ["cohort", "wechat", "month", "year", "taskMix", "status", "member", "type"];
      if (!Array.isArray(groupBy) || groupBy.length > 3 || new Set(groupBy).size !== groupBy.length || groupBy.some(key => !allowed.includes(key)) ||
        (groupBy.some(key => ["member", "type"].includes(key)) && !(groupBy.length === 1 || groupBy.length === 2 && groupBy.includes("member") && groupBy.includes("type")))) throw error("分组参数无效。成员与内容统计请单独分组或使用 member + type。");
      const taskGroups = groupBy.includes("member") || groupBy.includes("type"), groups = new Map();
      function add(key, order, item, legacy = false) {
        const hash = JSON.stringify(key);
        if (!groups.has(hash)) groups.set(hash, taskGroups ? { group: key, orderIds: new Set(), taskCount: 0, memberCostCents: 0, physicalCostCents: 0, paperCostCents: 0, unallocatedMemberCostCents: 0 } : { group: key, orders: [] });
        const group = groups.get(hash);
        if (taskGroups) {
          group.orderIds.add(order.id); group.taskCount += legacy ? 0 : 1;
          const amount = legacy ? order.unallocatedMemberCostCents : item.costCents;
          group.memberCostCents += amount;
          group[legacy ? "unallocatedMemberCostCents" : item.type === "实物" ? "physicalCostCents" : "paperCostCents"] += amount;
        } else group.orders.push(order);
      }
      for (const order of selected) {
        if (taskGroups) {
          for (const item of matchingWork(order, f)) add(Object.fromEntries(groupBy.map(key => [key, key === "member" ? item.member || "未分配" : item.type])), order, item);
          if (order.unallocatedMemberCostCents && !f.member && !f.types.length) add(Object.fromEntries(groupBy.map(key => [key, "待拆分（旧费用）"])), order, null, true);
        } else if (groupBy.length) add(Object.fromEntries(groupBy.map(key => [key, ({ cohort: order.cohort, wechat: order.wechat || "未记录", month: order.date?.slice(0, 7) || "日期未知", year: order.date?.slice(0, 4) || "日期未知", taskMix: [...order.types].sort().join("＋"), status: status(order) })[key]])), order);
      }
      const rows = [...groups.values()].map(group => {
        if (!taskGroups) return { group: group.group, ...totals(group.orders, f, today) };
        const { orderIds, ...rest } = group; return { ...rest, orderCount: orderIds.size };
      });
      const options = pageOptions(args, taskGroups ? ["memberCostCents", "orderCount", "taskCount", "group"] : [...METRICS.filter(key => key !== "ageDays"), "group"]);
      return { dateBasis: "接单日期；已收为当前累计余额，不能当作接单月实际收到的现金", filters: f,
        scope: "所有本地年级，按 filters 筛选", totals: totals(selected, f, today), groupBy,
        groupMeaning: taskGroups ? "任务费用统计；不分配订单售价、利润或已收。跨成员或实物/论文的订单数会重叠，不能相加。" : "每个订单只进入一个分组；利润为订单应收减全部成员费用。",
        ...paged(sorted(rows, options), options) };
    }
    function getOrders(args = {}) {
      validateKeys(args, ["filters", "limit", "offset", "sortBy", "direction"]);
      const f = filters(args.filters), selected = orders.filter(order => matches(order, f));
      const options = pageOptions(args, ["date", "code", ...METRICS.filter(key => key !== "orderCount")]);
      return { filters: f, totals: totals(selected, f, today), ...paged(sorted(selected.map(order => orderRow(order, today)), options), options) };
    }
    function payments(args = {}) {
      validateKeys(args, ["filters", "startDate", "endDate", "kind", "limit", "offset", "monthOffset", "sortBy", "direction"]);
      const f = filters(args.filters), start = date(args.startDate), end = date(args.endDate);
      if (start && end && start > end) throw error("收款开始日期不能晚于结束日期。");
      if (args.kind && !["opening", "receipt", "adjustment"].includes(args.kind)) throw error("收款记录类型无效。");
      const entries = orders.filter(order => matches(order, f)).flatMap(order => order.payments.map(entry => ({ ...entry,
        orderId: order.id, cohort: order.cohort, wechat: order.wechat, code: order.code, title: order.title })));
      const selected = entries.filter(p => (!args.kind || p.kind === args.kind) && (!start || p.date && p.date >= start) && (!end || p.date && p.date <= end));
      const empty = () => ({ entryCount: 0, receiptCents: 0, openingBalanceCents: 0, adjustmentCents: 0, balanceMovementCents: 0 });
      const total = empty(), months = new Map();
      for (const p of selected) {
        const month = p.date?.slice(0, 7) || "日期未知"; if (!months.has(month)) months.set(month, { month, ...empty() });
        for (const item of [total, months.get(month)]) { item.entryCount++; item.balanceMovementCents += p.amountCents;
          item[({ receipt: "receiptCents", opening: "openingBalanceCents", adjustment: "adjustmentCents" })[p.kind]] += p.amountCents; }
      }
      const options = pageOptions(args, ["date", "amountCents", "paidAfterCents"]);
      const monthPageOptions = pageOptions({ offset: args.monthOffset ?? 0, limit: 100 }, ["month"]);
      const monthPage = paged([...months.values()].sort((a, b) => b.month.localeCompare(a.month)), monthPageOptions);
      return { dateBasis: "收款记录日期；opening 是初始余额，adjustment 是账面修正，均不冒充 receipt 实际收款；未记录的历史流水无法还原。",
        filters: f, paymentStartDate: start, paymentEndDate: end, kind: args.kind || "all", totals: total, monthSummary: monthPage,
        ...paged(sorted(selected, options), options) };
    }
    function overview() {
      const all = report(); const rows = orders.map(order => orderRow(order, today));
      const availableMembers = [...new Set([...(context.members || []), ...orders.flatMap(order => order.workItems.map(item => item.member)).filter(Boolean)])];
      const fullDetail = JSON.stringify(rows);
      return { permission: "read_only", availableData: "当前浏览器保存的所有年级账本，包括未在页面选中的年级；没有其他设备或云端数据",
        snapshotDate: today, currentCohort: context.cohort, cohorts: [...new Set([...(context.cohorts || []), ...orders.map(order => order.cohort)])],
        members: availableMembers.slice(0, 100), availableMemberCount: availableMembers.length,
        memberDirectoryMode: availableMembers.length > 100 ? "首页提供100个姓名，其余已分配成员可通过 member 分组分页读取，也可直接用姓名查询；金额统计仍覆盖全部成员" : "全部成员姓名已提供",
        wechats: [...new Set([...(context.wechats || []), ...orders.map(order => order.wechat).filter(Boolean)])],
        moneyUnit: "所有 *Cents 字段单位是分，回答时除以 100 转为人民币元；*Pct 是百分数，如 25 表示 25%",
        totals: all.totals,
        byCohort: report({ groupBy: ["cohort"], limit: 100 }), byWechat: report({ groupBy: ["wechat"], limit: 100 }),
        byMember: report({ groupBy: ["member"], limit: 20 }), byType: report({ groupBy: ["type"], limit: 100 }),
        byOrderMonth: report({ groupBy: ["month"], sortBy: "group", limit: 12 }), byTaskMix: report({ groupBy: ["taskMix"], limit: 100 }),
        collectionHistory: payments({ limit: 1 }),
        largestOutstanding: getOrders({ filters: { status: "due" }, sortBy: "dueCents", limit: 10 }),
        lowestProfit: getOrders({ sortBy: "profitCents", direction: "asc", limit: 10 }),
        orderDetailsMode: fullDetail.length <= 32000 ? "全部订单明细已附上；完整收款历史通过工具读取" : "明细按需分页读取；所有汇总均覆盖全部订单，工具可读取任意年级任意订单，没有截断总账",
        ...(fullDetail.length <= 32000 ? { allOrderDetails: rows } : {}) };
    }
    const dispatch = (name, args) => {
      if (name === "ledger_report") return report(args);
      if (name === "ledger_orders") return getOrders(args);
      if (name === "ledger_payments") return payments(args);
      throw error("只有查看账本和财务统计权限，无法执行其他操作。");
    };
    return Object.freeze({ overview, dispatch, report, getOrders, payments });
  }
  const filterSchema = { type: "object", additionalProperties: false, properties: {
    cohort: { type: "string", description: "指定年级，省略为全部年级；这个年级使用 currentCohort" },
    wechat: { type: "string" }, member: { type: "string", description: "制作成员，可用未分配；与 types 一起限定匹配任务" },
    types: { type: "array", items: { type: "string", enum: TYPES }, description: "必须同时包含的制作内容" },
    code: { type: "string", description: "精确订单编号，可跨年级重复；用 id 区分" }, id: { type: "string" }, search: { type: "string", description: "题目或编号包含的关键词" },
    status: { type: "string", enum: ["all", "due", "unpaid", "partial", "paid"] },
    startDate: { type: "string", description: "接单开始日期 YYYY-MM-DD" }, endDate: { type: "string", description: "接单结束日期 YYYY-MM-DD" },
    ...Object.fromEntries(FILTER_KEYS.filter(key => /Cents$|Pct$/.test(key)).map(key => [key, { type: /Cents$/.test(key) ? "integer" : "number" }]))
  } };
  const pageSchema = { limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 }, direction: { type: "string", enum: ["asc", "desc"] } };
  const tool = (name, description, properties) => ({ type: "function", function: { name, description,
    parameters: { type: "object", additionalProperties: false, properties } } });
  const TOOLS = freeze([
    tool("ledger_report", "只读：统计全部匹配订单并进行年级/微信/月/年/任务组合/收款状态比较，或统计成员/实物/论文费用。总数和金额始终覆盖全部匹配记录。分组结果可分页，hasMore 为 true 时可继续读取。", {
      filters: filterSchema, groupBy: { type: "array", maxItems: 3, items: { type: "string", enum: ["cohort", "wechat", "month", "year", "taskMix", "status", "member", "type"] } },
      sortBy: { type: "string", enum: [...METRICS.filter(key => key !== "ageDays"), "taskCount", "group"], description: "group 按分组名称排序，月份可按此取最新月份" }, ...pageSchema }),
    tool("ledger_orders", "只读：查找或排序任意年级订单明细，包括成员分配、应收、已收、待收、费用、利润。使用分页；汇总覆盖所有匹配记录。", {
      filters: filterSchema, sortBy: { type: "string", enum: ["date", "code", ...METRICS.filter(key => key !== "orderCount")] }, ...pageSchema }),
    tool("ledger_payments", "只读：读取分次收款/初始余额/修正流水及收款日期的月汇总。filters 的日期为接单日期，顶层 startDate/endDate 是流水日期。receipt 才是已记录的实际客户收款，opening/adjustment 单列。", {
      filters: filterSchema, startDate: { type: "string" }, endDate: { type: "string" }, kind: { type: "string", enum: ["receipt", "opening", "adjustment"] },
      sortBy: { type: "string", enum: ["date", "amountCents", "paidAfterCents"] }, monthOffset: { type: "integer", minimum: 0, description: "monthSummary 月汇总的分页偏移，与流水 offset 无关" }, ...pageSchema })
  ]);
  const api = Object.freeze({ createSnapshot, TOOLS });
  if (typeof module === "object" && module.exports) module.exports = api; else root.LedgerAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
