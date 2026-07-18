/* ==========================================================================
   Data to Table App — Application Logic
   Columns are NOT fixed: they are discovered from whatever "Key: Value"
   pairs appear in the pasted text, CSV header row, or JSON keys.
   Modules: Storage, Parser, Column Registry, State/Table, Validation,
            Export/Import, Sorting/Filtering/Pagination, Inline Edit,
            Charts, Theme
   No frameworks — vanilla ES6+. No inline JS/CSS.
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------
     0. CONSTANTS & DOM REFERENCES
     ------------------------------------------------------------------ */
  const STORAGE_KEY = "dataToTable.records.v1";
  const COLUMNS_KEY = "dataToTable.columns.v1";
  const THEME_KEY = "dataToTable.theme.v1";

  const el = (id) => document.getElementById(id);

  const dom = {
    reportInput: el("reportInput"),
    btnInsert: el("btnInsert"),
    btnClearInput: el("btnClearInput"),
    btnClearTable: el("btnClearTable"),
    btnDeleteSelected: el("btnDeleteSelected"),
    btnCopyTable: el("btnCopyTable"),
    btnExportCsv: el("btnExportCsv"),
    btnExportXlsx: el("btnExportXlsx"),
    btnExportJson: el("btnExportJson"),
    btnImportCsv: el("btnImportCsv"),
    btnImportJson: el("btnImportJson"),
    fileImportCsv: el("fileImportCsv"),
    fileImportJson: el("fileImportJson"),
    parseStatus: el("parseStatus"),
    tableHeadRow: el("tableHeadRow"),
    tableBody: el("tableBody"),
    emptyState: el("emptyState"),
    selectAll: el("selectAll"),
    searchBox: el("searchBox"),
    pageSizeSelect: el("pageSizeSelect"),
    paginationInfo: el("paginationInfo"),
    paginationControls: el("paginationControls"),
    themeToggle: el("themeToggle"),
    themeIcon: el("themeIcon"),
    themeLabel: el("themeLabel"),
    toastContainer: el("toastContainer"),
    dashboardCards: el("dashboardCards"),
    chartsRow: el("chartsRow"),
    chartsEmptyState: el("chartsEmptyState")
  };

  /* ------------------------------------------------------------------
     1. STATE
     ------------------------------------------------------------------ */
  const state = {
    columns: [],         // [{ key, label, numeric }] — order = first-seen order
    records: [],          // [{ id, values: { colKey: rawString }, errors: {} }]
    filtered: [],
    sortKey: null,
    sortDir: "asc",
    pageSize: 25,
    currentPage: 1,
    selectedIds: new Set()
  };

  let charts = {}; // Chart.js instances keyed by column key

  /* ------------------------------------------------------------------
     2. UTILITIES
     ------------------------------------------------------------------ */
  function uid() {
    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function showToast(message, type = "success") {
    const toastEl = document.createElement("div");
    toastEl.className = `toast app-toast ${type === "error" ? "toast-error" : ""}`;
    toastEl.setAttribute("role", "alert");
    toastEl.innerHTML = `
      <div class="d-flex">
        <div class="toast-body">${escapeHtml(message)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>`;
    dom.toastContainer.appendChild(toastEl);
    const bsToast = new bootstrap.Toast(toastEl, { delay: 3200 });
    bsToast.show();
    toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Normalized form used as the column's stable identity key.
  // Two labels that only differ by casing/spacing map to the same column.
  function normalizeKey(rawKey) {
    return rawKey.trim().toLowerCase().replace(/\s+/g, " ");
  }

  /* ------------------------------------------------------------------
     3. COLUMN REGISTRY
     Columns are created the first time a key is seen and never removed
     automatically (only via Clear Table). Order = first appearance.
     ------------------------------------------------------------------ */
  function getOrCreateColumn(rawLabel) {
    const normKey = normalizeKey(rawLabel);
    let col = state.columns.find((c) => c.key === normKey);
    if (!col) {
      col = { key: normKey, label: rawLabel.trim(), numeric: true };
      state.columns.push(col);
    }
    return col;
  }

  // Recompute each column's "numeric" flag from current data.
  // A column is treated as numeric if every non-blank value across all
  // records is a valid number (auto-detected, per requirement).
  function recomputeColumnTypes() {
    state.columns.forEach((col) => {
      let sawValue = false;
      let allNumeric = true;
      state.records.forEach((r) => {
        const val = r.values[col.key];
        if (val === undefined || val === null || val === "") return;
        sawValue = true;
        if (isNaN(Number(val))) allNumeric = false;
      });
      col.numeric = sawValue ? allNumeric : false;
    });
  }

  /* ------------------------------------------------------------------
     4. PARSER — converts pasted text block(s) into record objects
        Any "Key: Value" line is accepted; keys are not restricted to a
        fixed list. Each distinct key becomes (or reuses) a column.
     ------------------------------------------------------------------ */
  function parseReports(text) {
    const results = [];
    const skippedBlocks = [];

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = normalized
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    blocks.forEach((block, blockIndex) => {
      const values = {};
      let matchedAnyField = false;

      block.split("\n").forEach((line) => {
        if (!line.trim()) return;
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) return; // ignore malformed line silently

        const rawKey = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        if (!rawKey) return; // ignore lines with no key before ":"

        const col = getOrCreateColumn(rawKey);
        values[col.key] = rawValue;
        matchedAnyField = true;
      });

      if (matchedAnyField) {
        results.push({ id: uid(), values, errors: {} });
      } else {
        skippedBlocks.push(blockIndex + 1);
      }
    });

    return { results, skippedBlocks };
  }

  /* ------------------------------------------------------------------
     5. VALIDATION
     Only rule that survives fixed-schema removal: numeric columns
     (auto-detected) must hold numeric values. Free-text columns have
     no required/format constraint since the schema is now open-ended.
     ------------------------------------------------------------------ */
  function validateRecord(record) {
    const errors = {};
    state.columns.forEach((col) => {
      if (!col.numeric) return;
      const val = record.values[col.key];
      if (val !== undefined && val !== null && val !== "" && isNaN(Number(val))) {
        errors[col.key] = "Must be a number.";
      }
    });
    return errors;
  }

  function revalidateAll() {
    recomputeColumnTypes();
    state.records.forEach((r) => {
      r.errors = validateRecord(r);
    });
  }

  /* ------------------------------------------------------------------
     6. DUPLICATE DETECTION
     Since columns are open-ended, a duplicate = every column's value
     matches exactly (case-insensitive, trimmed) across all known columns.
     ------------------------------------------------------------------ */
  function findDuplicate(values, excludeId = null) {
    return state.records.find((r) => {
      if (r.id === excludeId) return false;
      return state.columns.every((col) => {
        const a = (r.values[col.key] ?? "").trim().toLowerCase();
        const b = (values[col.key] ?? "").trim().toLowerCase();
        return a === b;
      });
    });
  }

  function confirmDuplicateInsert() {
    return new Promise((resolve) => {
      const modalEl = el("duplicateModal");
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      const yesBtn = el("duplicateYes");
      const noBtn = el("duplicateNo");

      const cleanup = () => {
        yesBtn.removeEventListener("click", onYes);
        noBtn.removeEventListener("click", onNo);
        modalEl.removeEventListener("hidden.bs.modal", onHidden);
      };
      const onYes = () => { cleanup(); modal.hide(); resolve(true); };
      const onNo = () => { cleanup(); modal.hide(); resolve(false); };
      const onHidden = () => { cleanup(); resolve(false); };

      yesBtn.addEventListener("click", onYes);
      noBtn.addEventListener("click", onNo);
      modalEl.addEventListener("hidden.bs.modal", onHidden, { once: true });

      modal.show();
    });
  }

  /* ------------------------------------------------------------------
     7. INSERT WORKFLOW (handles duplicates sequentially)
     ------------------------------------------------------------------ */
  async function insertRecords() {
    const text = dom.reportInput.value;
    if (!text.trim()) {
      setParseStatus("Please paste at least one record before inserting.", "error");
      return;
    }

    const { results, skippedBlocks } = parseReports(text);

    if (results.length === 0) {
      setParseStatus("No valid records found. Each record needs at least one \"Key: Value\" line.", "error");
      return;
    }

    let insertedCount = 0;
    let skippedDup = 0;

    for (const record of results) {
      const dup = findDuplicate(record.values);
      if (dup) {
        const proceed = await confirmDuplicateInsert();
        if (!proceed) { skippedDup++; continue; }
      }
      state.records.push(record);
      insertedCount++;
    }

    revalidateAll();
    persistAll();
    renderColumnHeaders();
    applyFilterSortPaginate();
    renderDashboard();
    renderCharts();

    let msg = `Inserted ${insertedCount} record(s) across ${state.columns.length} column(s).`;
    if (skippedDup > 0) msg += ` Skipped ${skippedDup} duplicate(s).`;
    if (skippedBlocks.length > 0) msg += ` ${skippedBlocks.length} block(s) had no recognizable "Key: Value" lines and were skipped.`;
    setParseStatus(msg, skippedBlocks.length > 0 ? "error" : "success");
    showToast(msg, "success");
  }

  function setParseStatus(message, type) {
    dom.parseStatus.textContent = message;
    dom.parseStatus.className = `parse-status mt-2 ${type}`;
  }

  /* ------------------------------------------------------------------
     8. STORAGE (localStorage persistence — records + column registry)
     ------------------------------------------------------------------ */
  function persistAll() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(state.columns));
    } catch (e) {
      showToast("Could not save to Local Storage (storage may be full).", "error");
    }
  }

  function loadAll() {
    try {
      const rawRecords = localStorage.getItem(STORAGE_KEY);
      const rawColumns = localStorage.getItem(COLUMNS_KEY);
      const records = rawRecords ? JSON.parse(rawRecords) : [];
      const columns = rawColumns ? JSON.parse(rawColumns) : [];
      return {
        records: Array.isArray(records) ? records : [],
        columns: Array.isArray(columns) ? columns : []
      };
    } catch (e) {
      return { records: [], columns: [] };
    }
  }

  /* ------------------------------------------------------------------
     9. FILTER / SORT / PAGINATION
     ------------------------------------------------------------------ */
  function applyFilterSortPaginate() {
    const query = dom.searchBox.value.trim().toLowerCase();

    if (!query) {
      state.filtered = state.records.slice();
    } else {
      state.filtered = state.records.filter((r) =>
        state.columns.some((col) => String(r.values[col.key] ?? "").toLowerCase().includes(query))
      );
    }

    if (state.sortKey) {
      const col = state.columns.find((c) => c.key === state.sortKey);
      const dir = state.sortDir === "asc" ? 1 : -1;
      state.filtered.sort((a, b) => {
        let va = a.values[state.sortKey];
        let vb = b.values[state.sortKey];
        if (col && col.numeric) {
          va = va === "" || va === undefined ? -Infinity : Number(va);
          vb = vb === "" || vb === undefined ? -Infinity : Number(vb);
          return (va - vb) * dir;
        }
        va = String(va ?? "").toLowerCase();
        vb = String(vb ?? "").toLowerCase();
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }

    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;

    renderTable();
    renderPagination();
  }

  function renderPagination() {
    const total = state.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    const start = total === 0 ? 0 : (state.currentPage - 1) * state.pageSize + 1;
    const end = Math.min(state.currentPage * state.pageSize, total);

    dom.paginationInfo.textContent = total === 0
      ? "No records to display."
      : `Showing ${start}\u2013${end} of ${total} record(s)`;

    dom.paginationControls.innerHTML = "";

    const makePageItem = (label, page, disabled, active) => {
      const li = document.createElement("li");
      li.className = `page-item ${disabled ? "disabled" : ""} ${active ? "active" : ""}`;
      const a = document.createElement("a");
      a.className = "page-link";
      a.href = "#";
      a.textContent = label;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (disabled) return;
        state.currentPage = page;
        renderTable();
        renderPagination();
      });
      li.appendChild(a);
      return li;
    };

    dom.paginationControls.appendChild(makePageItem("\u00AB", state.currentPage - 1, state.currentPage === 1, false));

    const maxButtons = 5;
    let startPage = Math.max(1, state.currentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);
    startPage = Math.max(1, endPage - maxButtons + 1);

    for (let p = startPage; p <= endPage; p++) {
      dom.paginationControls.appendChild(makePageItem(String(p), p, false, p === state.currentPage));
    }

    dom.paginationControls.appendChild(makePageItem("\u00BB", state.currentPage + 1, state.currentPage === totalPages, false));
  }

  /* ------------------------------------------------------------------
     10. TABLE HEADER RENDERING (dynamic columns)
     ------------------------------------------------------------------ */
  function renderColumnHeaders() {
    // Remove existing data column headers (keep checkbox + # columns)
    Array.from(dom.tableHeadRow.querySelectorAll("th.data-col")).forEach((th) => th.remove());

    state.columns.forEach((col) => {
      const th = document.createElement("th");
      th.className = "data-col";
      th.dataset.sort = col.key;
      th.innerHTML = `${escapeHtml(col.label)} <i class="bi bi-arrow-down-up sort-icon"></i>`;
      th.addEventListener("click", () => {
        if (state.sortKey === col.key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = col.key;
          state.sortDir = "asc";
        }
        document.querySelectorAll(".sort-icon").forEach((icon) => {
          icon.classList.remove("active-asc", "active-desc");
        });
        const icon = th.querySelector(".sort-icon");
        if (icon) icon.classList.add(state.sortDir === "asc" ? "active-asc" : "active-desc");
        applyFilterSortPaginate();
      });
      dom.tableHeadRow.appendChild(th);
    });
  }

  /* ------------------------------------------------------------------
     11. TABLE BODY RENDERING
     ------------------------------------------------------------------ */
  function renderTable() {
    dom.tableBody.innerHTML = "";

    if (state.records.length === 0) {
      dom.emptyState.classList.remove("d-none");
    } else {
      dom.emptyState.classList.add("d-none");
    }

    const startIdx = (state.currentPage - 1) * state.pageSize;
    const pageItems = state.filtered.slice(startIdx, startIdx + state.pageSize);

    const fragment = document.createDocumentFragment();

    pageItems.forEach((record, i) => {
      const tr = document.createElement("tr");
      tr.dataset.id = record.id;
      const hasErrors = record.errors && Object.keys(record.errors).length > 0;
      if (hasErrors) tr.classList.add("row-invalid");

      const tdCheck = document.createElement("td");
      tdCheck.className = "col-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "row-select";
      checkbox.checked = state.selectedIds.has(record.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedIds.add(record.id);
        else state.selectedIds.delete(record.id);
        syncSelectAllState();
      });
      tdCheck.appendChild(checkbox);
      tr.appendChild(tdCheck);

      const tdNum = document.createElement("td");
      tdNum.className = "col-num";
      tdNum.textContent = String(startIdx + i + 1);
      tr.appendChild(tdNum);

      state.columns.forEach((col) => {
        const td = document.createElement("td");
        td.className = "editable-cell";
        td.dataset.field = col.key;
        const value = record.values[col.key] ?? "";
        td.textContent = value;

        if (record.errors && record.errors[col.key]) {
          const errSpan = document.createElement("span");
          errSpan.className = "cell-error";
          errSpan.textContent = record.errors[col.key];
          td.appendChild(errSpan);
        }

        td.addEventListener("dblclick", () => startInlineEdit(td, record, col));
        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    dom.tableBody.appendChild(fragment);
    syncSelectAllState();
  }

  function syncSelectAllState() {
    const rowCheckboxes = Array.from(document.querySelectorAll(".row-select"));
    if (rowCheckboxes.length === 0) {
      dom.selectAll.checked = false;
      dom.selectAll.indeterminate = false;
      return;
    }
    const checkedCount = rowCheckboxes.filter((cb) => cb.checked).length;
    dom.selectAll.checked = checkedCount === rowCheckboxes.length;
    dom.selectAll.indeterminate = checkedCount > 0 && checkedCount < rowCheckboxes.length;
  }

  /* ------------------------------------------------------------------
     12. INLINE EDITING
     ------------------------------------------------------------------ */
  function startInlineEdit(td, record, col) {
    if (td.classList.contains("editing")) return;
    const currentValue = record.values[col.key] ?? "";
    td.classList.add("editing");
    td.innerHTML = "";

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentValue;
    td.appendChild(input);
    input.focus();
    input.select();

    let committed = false;

    const commit = () => {
      if (committed) return;
      committed = true;
      const newValue = input.value.trim();
      record.values[col.key] = newValue;
      revalidateAll();
      persistAll();
      renderColumnHeaders();
      applyFilterSortPaginate();
      renderDashboard();
      renderCharts();
    };

    const cancel = () => {
      committed = true;
      applyFilterSortPaginate();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });

    input.addEventListener("blur", () => {
      commit();
    });
  }

  /* ------------------------------------------------------------------
     13. DELETE OPERATIONS
     ------------------------------------------------------------------ */
  function deleteSelected() {
    if (state.selectedIds.size === 0) {
      showToast("No rows selected.", "error");
      return;
    }
    el("deleteSelectedMessage").textContent =
      `This will remove ${state.selectedIds.size} selected row(s). This cannot be undone.`;
    const modal = bootstrap.Modal.getOrCreateInstance(el("deleteSelectedModal"));
    modal.show();
  }

  function clearTable() {
    if (state.records.length === 0) {
      showToast("Table is already empty.", "error");
      return;
    }
    const modal = bootstrap.Modal.getOrCreateInstance(el("clearTableModal"));
    modal.show();
  }

  /* ------------------------------------------------------------------
     14. DASHBOARD (auto-generated: Total Records + one card per
         numeric column, summing that column's values)
     ------------------------------------------------------------------ */
  function renderDashboard() {
    dom.dashboardCards.innerHTML = "";

    const totalCard = buildStatCard("Total Records", state.records.length.toLocaleString(), true);
    dom.dashboardCards.appendChild(totalCard);

    const numericCols = state.columns.filter((c) => c.numeric);
    numericCols.forEach((col) => {
      const sum = state.records.reduce((acc, r) => acc + (Number(r.values[col.key]) || 0), 0);
      const card = buildStatCard(col.label, sum.toLocaleString(), false);
      dom.dashboardCards.appendChild(card);
    });
  }

  function buildStatCard(label, value, isGold) {
    const wrapper = document.createElement("div");
    wrapper.className = "col-6 col-md-4 col-lg-2";
    wrapper.innerHTML = `
      <div class="stat-card ${isGold ? "stat-card-gold" : ""}">
        <div class="stat-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
        <div class="stat-value">${escapeHtml(value)}</div>
      </div>`;
    return wrapper;
  }

  /* ------------------------------------------------------------------
     15. CHARTS — one bar chart per numeric column, plotted against the
         first non-numeric column (used as the label axis). Falls back
         to record index if no text column exists.
     ------------------------------------------------------------------ */
  function getLabelColumn() {
    return state.columns.find((c) => !c.numeric) || null;
  }

  function buildChartData(metricCol, labelCol) {
    const grouped = new Map();
    state.records.forEach((r, idx) => {
      const label = labelCol ? (r.values[labelCol.key] || "Unknown") : `#${idx + 1}`;
      const val = Number(r.values[metricCol.key]) || 0;
      grouped.set(label, (grouped.get(label) || 0) + val);
    });
    return { labels: Array.from(grouped.keys()), data: Array.from(grouped.values()) };
  }

  function renderCharts() {
    if (typeof Chart === "undefined") return;

    const numericCols = state.columns.filter((c) => c.numeric);
    const labelCol = getLabelColumn();

    // Rebuild the charts row's canvases to match current numeric columns
    Object.values(charts).forEach((c) => c.destroy());
    charts = {};
    dom.chartsRow.innerHTML = "";

    if (numericCols.length === 0) {
      dom.chartsRow.appendChild(dom.chartsEmptyState);
      dom.chartsEmptyState.classList.remove("d-none");
      return;
    }
    dom.chartsEmptyState.classList.add("d-none");

    const styles = getComputedStyle(document.documentElement);
    const tealColor = styles.getPropertyValue("--teal-bright").trim() || "#3fc9b8";
    const goldColor = styles.getPropertyValue("--gold").trim() || "#d4af37";
    const textColor = styles.getPropertyValue("--text").trim() || "#eaf3f2";
    const gridColor = styles.getPropertyValue("--border").trim() || "#1e565c";

    numericCols.forEach((col, i) => {
      const colWrap = document.createElement("div");
      colWrap.className = "col-lg-6";
      const chartCard = document.createElement("div");
      chartCard.className = "chart-card";
      const canvas = document.createElement("canvas");
      canvas.height = 220;
      chartCard.appendChild(canvas);
      colWrap.appendChild(chartCard);
      dom.chartsRow.appendChild(colWrap);

      const { labels, data } = buildChartData(col, labelCol);
      const color = i % 2 === 0 ? tealColor : goldColor;
      const chartTitle = labelCol ? `${col.label} by ${labelCol.label}` : `${col.label} by Record`;

      charts[col.key] = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [{ label: chartTitle, data, backgroundColor: color, borderRadius: 4 }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { display: false },
            title: { display: true, text: chartTitle, color: textColor }
          },
          scales: {
            x: { ticks: { color: textColor }, grid: { color: gridColor } },
            y: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true }
          }
        }
      });
    });
  }

  /* ------------------------------------------------------------------
     16. EXPORT — CSV / Excel / JSON / Copy (columns = current registry)
     ------------------------------------------------------------------ */
  function recordsToRows() {
    return state.records.map((r) => {
      const row = {};
      state.columns.forEach((col) => { row[col.label] = r.values[col.key] ?? ""; });
      return row;
    });
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function toCsv(rows) {
    const headers = state.columns.map((c) => c.label);
    if (headers.length === 0) return "";
    const escapeCsvValue = (val) => {
      const str = String(val ?? "");
      if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
      return str;
    };
    const lines = [headers.map(escapeCsvValue).join(",")];
    rows.forEach((row) => {
      lines.push(headers.map((h) => escapeCsvValue(row[h])).join(","));
    });
    return lines.join("\n");
  }

  function exportCsv() {
    if (state.records.length === 0) {
      showToast("No records to export.", "error");
      return;
    }
    const csv = toCsv(recordsToRows());
    downloadBlob(csv, "DataToTable.csv", "text/csv;charset=utf-8;");
    showToast("Exported DataToTable.csv");
  }

  function exportXlsx() {
    if (state.records.length === 0) {
      showToast("No records to export.", "error");
      return;
    }
    if (typeof XLSX === "undefined") {
      showToast("Excel export library failed to load.", "error");
      return;
    }
    const rows = recordsToRows();
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: state.columns.map((c) => c.label) });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Data");
    XLSX.writeFile(workbook, "DataToTable.xlsx");
    showToast("Exported DataToTable.xlsx");
  }

  function exportJson() {
    if (state.records.length === 0) {
      showToast("No records to export.", "error");
      return;
    }
    // Export as an array of plain objects keyed by column label (not internal keys)
    const exportable = state.records.map((r) => {
      const obj = {};
      state.columns.forEach((col) => { obj[col.label] = r.values[col.key] ?? ""; });
      return obj;
    });
    const json = JSON.stringify(exportable, null, 2);
    downloadBlob(json, "DataToTable.json", "application/json;charset=utf-8;");
    showToast("Exported DataToTable.json");
  }

  async function copyTable() {
    if (state.filtered.length === 0) {
      showToast("No records to copy.", "error");
      return;
    }
    const headers = state.columns.map((c) => c.label).join("\t");
    const rows = state.filtered.map((r) => state.columns.map((c) => r.values[c.key] ?? "").join("\t"));
    const text = [headers, ...rows].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast("Table copied to clipboard.");
    } catch (e) {
      showToast("Could not copy to clipboard.", "error");
    }
  }

  /* ------------------------------------------------------------------
     17. IMPORT — CSV / JSON (append; header row / object keys define
         columns directly, reusing existing columns where names match)
     ------------------------------------------------------------------ */
  function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (inQuotes) {
        if (ch === '"') {
          if (normalized[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          row.push(field);
          field = "";
        } else if (ch === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  }

  async function importRowsAsRecords(rawObjects) {
    let inserted = 0;
    let skipped = 0;

    for (const raw of rawObjects) {
      const values = {};
      Object.keys(raw).forEach((label) => {
        const col = getOrCreateColumn(label);
        values[col.key] = raw[label] !== undefined && raw[label] !== null ? String(raw[label]) : "";
      });

      const dup = findDuplicate(values);
      if (dup) {
        const proceed = await confirmDuplicateInsert();
        if (!proceed) { skipped++; continue; }
      }

      state.records.push({ id: uid(), values, errors: {} });
      inserted++;
    }

    revalidateAll();
    persistAll();
    renderColumnHeaders();
    applyFilterSortPaginate();
    renderDashboard();
    renderCharts();
    showToast(`Imported ${inserted} record(s).${skipped ? " Skipped " + skipped + " duplicate(s)." : ""}`);
  }

  function importCsvFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      const text = String(reader.result);
      const rows = parseCsvText(text);
      if (rows.length < 2) {
        showToast("CSV file has no data rows.", "error");
        return;
      }
      const headerRow = rows[0];
      const rawObjects = rows.slice(1).map((row) => {
        const obj = {};
        headerRow.forEach((label, idx) => {
          if (label && label.trim()) obj[label.trim()] = row[idx] ?? "";
        });
        return obj;
      });
      await importRowsAsRecords(rawObjects);
    };
    reader.onerror = () => showToast("Could not read CSV file.", "error");
    reader.readAsText(file);
  }

  function importJsonFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!Array.isArray(parsed)) {
          showToast("JSON file must contain an array of records.", "error");
          return;
        }
        await importRowsAsRecords(parsed);
      } catch (e) {
        showToast("Invalid JSON file.", "error");
      }
    };
    reader.onerror = () => showToast("Could not read JSON file.", "error");
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------
     18. THEME (dark/light with persistence)
     ------------------------------------------------------------------ */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "dark") {
      dom.themeIcon.className = "bi bi-sun-fill";
      dom.themeLabel.textContent = "Light Mode";
    } else {
      dom.themeIcon.className = "bi bi-moon-stars-fill";
      dom.themeLabel.textContent = "Dark Mode";
    }
    localStorage.setItem(THEME_KEY, theme);
    renderCharts();
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  }

  /* ------------------------------------------------------------------
     19. EVENT WIRING
     ------------------------------------------------------------------ */
  function wireEvents() {
    dom.btnInsert.addEventListener("click", insertRecords);

    dom.btnClearInput.addEventListener("click", () => {
      dom.reportInput.value = "";
      setParseStatus("", "");
    });

    dom.btnClearTable.addEventListener("click", clearTable);
    el("clearTableConfirm").addEventListener("click", () => {
      state.records = [];
      state.columns = [];
      state.selectedIds.clear();
      state.sortKey = null;
      persistAll();
      renderColumnHeaders();
      applyFilterSortPaginate();
      renderDashboard();
      renderCharts();
      bootstrap.Modal.getInstance(el("clearTableModal")).hide();
      showToast("All records and columns deleted.");
    });

    dom.btnDeleteSelected.addEventListener("click", deleteSelected);
    el("deleteSelectedConfirm").addEventListener("click", () => {
      state.records = state.records.filter((r) => !state.selectedIds.has(r.id));
      state.selectedIds.clear();
      revalidateAll();
      persistAll();
      applyFilterSortPaginate();
      renderDashboard();
      renderCharts();
      bootstrap.Modal.getInstance(el("deleteSelectedModal")).hide();
      showToast("Selected records deleted.");
    });

    dom.btnCopyTable.addEventListener("click", copyTable);
    dom.btnExportCsv.addEventListener("click", exportCsv);
    dom.btnExportXlsx.addEventListener("click", exportXlsx);
    dom.btnExportJson.addEventListener("click", exportJson);

    dom.btnImportCsv.addEventListener("click", () => dom.fileImportCsv.click());
    dom.fileImportCsv.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importCsvFile(file);
      e.target.value = "";
    });

    dom.btnImportJson.addEventListener("click", () => dom.fileImportJson.click());
    dom.fileImportJson.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importJsonFile(file);
      e.target.value = "";
    });

    dom.selectAll.addEventListener("change", () => {
      const checked = dom.selectAll.checked;
      const startIdx = (state.currentPage - 1) * state.pageSize;
      const pageItems = state.filtered.slice(startIdx, startIdx + state.pageSize);
      pageItems.forEach((r) => {
        if (checked) state.selectedIds.add(r.id);
        else state.selectedIds.delete(r.id);
      });
      renderTable();
    });

    dom.searchBox.addEventListener("input", () => {
      state.currentPage = 1;
      applyFilterSortPaginate();
    });

    dom.pageSizeSelect.addEventListener("change", () => {
      state.pageSize = Number(dom.pageSizeSelect.value);
      state.currentPage = 1;
      applyFilterSortPaginate();
    });

    dom.themeToggle.addEventListener("click", toggleTheme);
  }

  /* ------------------------------------------------------------------
     20. INIT
     ------------------------------------------------------------------ */
  function init() {
    const savedTheme = localStorage.getItem(THEME_KEY) || "dark";
    applyTheme(savedTheme);

    const loaded = loadAll();
    state.records = loaded.records;
    state.columns = loaded.columns;
    revalidateAll();

    wireEvents();
    renderColumnHeaders();
    applyFilterSortPaginate();
    renderDashboard();
    renderCharts();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
