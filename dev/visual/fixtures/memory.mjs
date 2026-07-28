import { I } from "./icons.mjs";
import { sw } from "./primitives.mjs";

export const memoryRow = (name, type, desc, on = true, confirming = false) =>
  `<tr class="${on ? "" : "is-off"}${confirming ? " is-confirming-delete" : ""}">
    <td class="lmsa-memory-col-switch">${sw(on ? "is-enabled" : "")}</td>
    <td class="lmsa-memory-cell-name">${name}</td>
    <td><span class="lmsa-memory-badge is-${type}">${type === "rule" ? "Rule" : "Context"}</span></td>
    <td class="lmsa-memory-cell-desc">${desc}</td>
    <td class="lmsa-memory-col-actions">${
      confirming
        ? `<button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-danger">Delete</button>
           <button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary">Cancel</button>`
        : `<button class="lmsa-ui-btn lmsa-ui-btn-secondary lmsa-memory-icon-btn" aria-label="Edit">${I.pencil}</button>
           <button class="lmsa-ui-btn lmsa-btn-danger lmsa-memory-icon-btn" aria-label="Delete">${I.trash}</button>`
    }</td>
  </tr>`;

export const memoryTable = (rows) =>
  `<div class="lmsa-memory-capacity">
    <div class="lmsa-memory-capacity-header">
      <span class="lmsa-memory-capacity-label">Index budget (advisory)</span>
      <span class="lmsa-memory-capacity-value">~180 of 3.0k tokens (6%)</span>
    </div>
    <div class="lmsa-index-progress-bar"><div class="lmsa-index-progress-fill" style="width:6%"></div></div>
  </div>
  <div class="lmsa-memory-list"><table class="lmsa-memory-table">
    <thead><tr>
      <th class="lmsa-memory-col-switch"></th><th>Name</th><th>Type</th><th>Description</th>
      <th class="lmsa-memory-col-actions"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
`;

// Feature off: the table is not rendered at all, the body carries the message.
export const memoryOffState = () =>
  `<div class="lmsa-memory-list"><div class="lmsa-memory-off-state">
    <div class="lmsa-memory-off-title">Memories are off</div>
    <div class="lmsa-memory-off-hint">Enable memories above to edit, delete, add and use these entries.</div>
  </div></div>`;
