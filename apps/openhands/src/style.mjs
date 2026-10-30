// Loaded inside the page's shadow root; these rules never style the host application.
export const styles = `
:host {
  display: block;
  min-width: 0;
  container-type: inline-size;
  color-scheme: dark;
  --ground: #171719;
  --surface: #131217;
  --raised: #212023;
  --border: #2b2a2f;
  --control: #45444a;
  --text: #f3f3f4;
  --muted: #a5a5ad;
  --accent: #72a8e9;
  --positive: #5fc39c;
  --warning: #e3b35e;
  --negative: #ef8597;
  font: 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
h1, h2, h3, p { margin: 0; }
button, input, select { font: inherit; }
button, input, select, summary { touch-action: manipulation; }
button, input, select {
  min-height: 40px;
  min-width: 0;
  padding: 7px 11px;
  border: 1px solid var(--control);
  border-radius: 6px;
  color: var(--text);
  background: var(--ground);
}
button, select, summary { cursor: pointer; }
button:hover { border-color: var(--muted); }
button:active { background: var(--raised); }
button[aria-disabled="true"], select:disabled { color: var(--muted); cursor: wait; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible,
[tabindex="0"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
input::placeholder { color: var(--muted); }
select { width: 100%; max-width: 100%; }
p, h1, h2, h3, li, dd { overflow-wrap: anywhere; }
h1 { font-size: 25px; line-height: 1.2; font-weight: 600; letter-spacing: -.025em; }
h2 { font-size: 15px; font-weight: 600; }
h3 { font-size: 14px; font-weight: 500; }
.app { min-height: 360px; padding: 24px; color: var(--text); background: var(--ground); }
.topbar, .heading, .panel-heading, .actions, .legend, .facts, .timing-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.topbar { padding-bottom: 18px; margin-bottom: 22px; border-bottom: 1px solid var(--border); }
.brand { font-size: 23px; font-weight: 650; letter-spacing: -.05em; }
.brand-mark { display: inline-block; color: var(--accent); letter-spacing: -.18em; margin-right: 10px; }
.backend { color: var(--muted); overflow-wrap: anywhere; min-width: 0; flex: 1; }
.badge { border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; font-size: 11px; color: var(--muted); }
.heading { align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
.heading p { margin-top: 7px; color: var(--muted); }
.toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: end; }
.field { display: grid; gap: 6px; min-width: 0; }
.field > label, .field-label { color: var(--muted); font-size: 12px; }
.auto-refresh { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; min-height: 40px; color: var(--muted); }
.auto-refresh input { min-height: 0; width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.freshness { min-height: 24px; margin: 10px 0 16px; font-size: 12px; color: var(--muted); }
.timing { padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; }
.timing-heading { justify-content: space-between; gap: 16px; }
.offset-form { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; }
.offset-form input { width: 116px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.timing-copy { max-width: 85ch; color: var(--muted); font-size: 12px; margin-top: 10px; }
.timing details { color: var(--muted); font-size: 12px; margin-top: 8px; }
.timing details p { padding-top: 8px; }
.offset-error { color: var(--negative); font-size: 12px; margin-top: 8px; }
.error { border: 1px solid #6e3d47; background: #251c21; padding: 12px 14px; border-radius: 6px; margin-bottom: 16px; color: #f6c3cd; }
.facts { gap: 14px 30px; margin-bottom: 18px; }
.fact { display: flex; align-items: baseline; gap: 8px; color: var(--muted); font-size: 12px; }
.fact strong { color: var(--text); font-weight: 500; font-size: 18px; }
.fact:last-child strong { font-size: 13px; }
.warnings { border-left: 2px solid var(--warning); background: var(--surface); padding: 10px 14px; margin-bottom: 16px; }
.warnings summary { color: var(--warning); }
.warnings ul { margin: 10px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
.warnings li + li { margin-top: 6px; }
.panel { min-width: 0; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; }
.panel-heading { justify-content: space-between; padding: 15px 16px 8px; }
.count { color: var(--muted); font-size: 12px; font-weight: 400; margin-left: 7px; }
.section-note { color: var(--muted); font-size: 12px; padding: 0 16px 12px; }
.waterfall { max-height: 360px; overflow: auto; padding: 0 16px 12px; }
.axis, .lane { display: grid; grid-template-columns: 95px minmax(0, 1fr); gap: 12px; }
.axis { color: var(--muted); font-size: 11px; padding: 8px 0; }
.axis-times { display: flex; justify-content: space-between; gap: 8px; }
.lane { align-items: center; border-top: 1px solid var(--border); }
.lane-name { font-size: 12px; align-self: start; padding-top: 13px; }
.lane-track { position: relative; height: 44px; min-width: 0; }
.lane-track::before { content: ''; position: absolute; inset: 13px 0; background: var(--ground); border-radius: 3px; }
.span-mark { position: absolute; top: 4px; height: 36px; min-height: 36px; min-width: 7px; padding: 0; border: 0; border-radius: 2px; background: transparent; }
.span-mark::before { content: ''; position: absolute; top: 9px; bottom: 9px; left: 0; right: 0; background: var(--kind-color); border-radius: 2px; opacity: .85; }
.span-mark[aria-pressed="true"]::before { outline: 2px solid var(--text); outline-offset: 2px; opacity: 1; }
.span-mark:hover, .span-mark:focus-visible { z-index: 2; background: transparent; }
.span-mark.open::before { background: transparent; border: 2px dotted var(--kind-color); }
.kind-thinking { --kind-color: var(--positive); }
.kind-tool { --kind-color: var(--warning); }
.kind-subagent { --kind-color: var(--accent); }
.kind-error { --kind-color: var(--negative); }
.kind-message { --kind-color: var(--muted); }
.legend { border-top: 1px solid var(--border); padding: 11px 16px; gap: 8px 16px; color: var(--muted); font-size: 11px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-mark { width: 8px; height: 8px; border-radius: 1px; background: var(--kind-color); }
.empty { padding: 22px 16px; color: var(--muted); }
.waterfall > .empty { padding-left: 0; padding-right: 0; }
.lower-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-top: 16px; align-items: start; }
.console { max-height: 420px; overflow: auto; padding: 0 16px; }
.event-item { border-top: 1px solid var(--border); padding: 10px 0; }
.event-button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 44px; padding: 7px 0; border: 0; background: transparent; border-radius: 0; text-align: left; }
.event-button[aria-pressed="true"] { color: var(--accent); }
.event-button:hover { background: var(--raised); }
.event-button .legend-mark { flex: 0 0 8px; }
.event-label { overflow-wrap: anywhere; min-width: 0; }
.event-meta { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.event-preview { color: var(--muted); margin-top: 6px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.more { margin: 12px 16px; }
.detail-content { padding: 10px 16px 16px; }
.detail-meta { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 12px; margin: 12px 0; font-size: 12px; }
.detail-meta dt { color: var(--muted); }
.detail-meta dd { margin: 0; }
.detail-pre { margin: 12px 0 0; padding: 12px; border-radius: 4px; background: var(--ground); color: var(--muted); font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.untimed-panel { margin-top: 16px; }
.untimed-list { list-style: none; margin: 0; padding: 0 16px; max-height: 340px; overflow: auto; }
.untimed-item { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 5px 14px; border-top: 1px solid var(--border); padding: 12px 0; }
.untimed-kind { color: var(--muted); font-size: 12px; }
.untimed-time { grid-column: 2; font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--muted); overflow-wrap: anywhere; }
.footer { color: var(--muted); font-size: 11px; margin-top: 18px; }
@container (max-width: 680px) {
  .app { padding: 16px; }
  .topbar { gap: 8px 12px; margin-bottom: 18px; }
  .backend { flex-basis: calc(100% - 120px); }
  .toolbar { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .actions { justify-content: space-between; }
  .lower-grid { grid-template-columns: minmax(0, 1fr); }
  .offset-form { width: 100%; }
  .offset-form .field { flex: 1; }
  .offset-form input { width: 100%; }
  .timing-heading { gap: 10px; }
  .axis, .lane { grid-template-columns: 70px minmax(0, 1fr); gap: 8px; }
  .axis-mid { display: none; }
  .facts { gap: 10px 20px; }
  .untimed-item { grid-template-columns: 70px minmax(0, 1fr); gap: 5px 8px; }
  button, input, select, .auto-refresh { min-height: 44px; }
  .auto-refresh input { min-height: 0; }
  .span-mark { min-height: 36px; }
}
`;
