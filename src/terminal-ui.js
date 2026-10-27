import { emitKeypressEvents } from 'node:readline';

export class UiCanceled extends Error {
  constructor() { super('已退出交互配置，未保存的修改已放弃。'); this.name = 'UiCanceled'; }
}
// Values from files/model catalogs must not be able to inject terminal controls.
const safe = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

export class TerminalUi {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error('交互配置需要真实终端。请在 PowerShell 或 Windows Terminal 中运行 npm run config；查看脱敏配置请用 config --show。');
    this.input = input; this.output = output; this.originalRaw = Boolean(input.isRaw); this.originalFlowing = input.readableFlowing;
    this.queue = [];
    this.onKey = (text, key = {}) => {
      const cancel = key.ctrl && key.name === 'c';
      if (this.busyController) { if (cancel || key.name === 'escape') this.busyController.abort(); return; }
      const item = cancel ? new UiCanceled() : { text, ...key };
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; item instanceof Error ? waiter.reject(item) : waiter.resolve(item); }
      else if (this.queue.length < 32768) this.queue.push(item);
    };
    this.onEnd = () => { if (this.waiter) { this.waiter.reject(new UiCanceled()); this.waiter = undefined; } };
    input.on('keypress', this.onKey); input.on('end', this.onEnd);
    emitKeypressEvents(input); input.setRawMode(true); input.resume();
    output.write('\x1b[?1049h\x1b[?25l');
  }
  render(title, lines, footer = '↑↓ 选择 · Enter 确认 · Esc 返回 · Ctrl+C 退出') {
    const width = Math.max(30, (this.output.columns || 80) - 2);
    const clip = value => Array.from(safe(value)).slice(0, width).join('');
    this.output.write('\x1b[H\x1b[2J' + '\x1b[1;36mNotionSI · 模型配置\x1b[0m\n\n' + clip(title) + '\n\n' +
      lines.map(line => clip(line)).join('\n') + '\n\n' + clip(footer));
  }
  key() {
    if (this.queue.length) { const item = this.queue.shift(); return item instanceof Error ? Promise.reject(item) : Promise.resolve(item); }
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  async choose(title, choices, { initial = 0, note = '' } = {}) {
    let selected = Math.max(0, Math.min(initial, choices.length - 1));
    for (;;) {
      const visible = Math.max(4, (this.output.rows || 24) - (note ? 10 : 8));
      const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), choices.length - visible));
      this.render(title, [ ...(note ? [note, ''] : []), ...choices.slice(start, start + visible).map((c, i) => `${start + i === selected ? '›' : ' '} ${c.label}`),
        ...(choices.length > visible ? [`(${selected + 1}/${choices.length})`] : []) ]);
      const key = await this.key();
      if (key.name === 'escape') return undefined;
      if (key.name === 'return') return choices[selected].value;
      if (key.name === 'up' || key.name === 'k') selected = (selected + choices.length - 1) % choices.length;
      if (key.name === 'down' || key.name === 'j') selected = (selected + 1) % choices.length;
      if (key.name === 'home') selected = 0;
      if (key.name === 'end') selected = choices.length - 1;
    }
  }
  async inputValue(title, { initial = '', secret = false, note = '' } = {}) {
    let value = Array.from(initial), cursor = value.length;
    for (;;) {
      const display = secret ? '•'.repeat(Math.min(48, value.length)) : `${value.slice(0, cursor).join('')}│${value.slice(cursor).join('')}`;
      this.render(title, [note, '', `> ${display}`, '', secret ? '输入已隐藏；留空保留现有 Key。' : 'Ctrl+U 清空；←→ 移动光标。'], 'Enter 确认 · Esc 取消 · Ctrl+C 退出');
      const key = await this.key();
      if (key.name === 'escape') return null;
      if (key.name === 'return') return value.join('');
      if (key.ctrl && key.name === 'u') { value = []; cursor = 0; }
      else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'right') cursor = Math.min(value.length, cursor + 1);
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = value.length;
      else if (key.name === 'backspace' && cursor) { value.splice(--cursor, 1); }
      else if (key.name === 'delete') value.splice(cursor, 1);
      else if (!key.ctrl && !key.meta && key.text && !/[\x00-\x1f\x7f]/.test(key.text) && value.length < 16384) {
        const text = Array.from(key.text); value.splice(cursor, 0, ...text); cursor += text.length;
      }
    }
  }
  async message(title, text) {
    this.render(title, String(text).split('\n'), '按任意键继续 · Ctrl+C 退出'); await this.key();
  }
  async task(title, work) {
    const controller = new AbortController();
    this.busyController = controller; this.queue = [];
    this.render(title, ['正在处理…'], 'Esc / Ctrl+C 取消当前操作');
    try { return await work(controller.signal); } finally { this.busyController = undefined; }
  }
  async external(work) {
    this.input.off('keypress', this.onKey);
    this.output.write('\x1b[?25h\x1b[?1049l'); this.input.setRawMode(false); this.input.pause();
    try { return await work(); }
    finally { this.input.on('keypress', this.onKey); this.input.setRawMode(true); this.input.resume(); this.output.write('\x1b[?1049h\x1b[?25l'); }
  }
  close() {
    this.input.off('keypress', this.onKey); this.input.off('end', this.onEnd);
    this.output.write('\x1b[?25h\x1b[?1049l'); this.input.setRawMode(this.originalRaw);
    if (this.originalFlowing !== true) this.input.pause();
  }
}
