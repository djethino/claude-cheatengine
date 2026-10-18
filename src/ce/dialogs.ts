/**
 * Dialogs open in Cheat Engine. CE runs every pipe script on its main thread, so a modal dialog
 * (an error, a question) blocks all calls until someone answers it. They are seen from outside CE
 * (src/win/helper.ts), which works while CE is blocked.
 *
 * The rule: a dialog with a single button only informs (an error, a notice): Claude may close it
 * once it has read it. A dialog with a choice (Yes/No/Cancel: an unlock, "run this table's Lua
 * script?", "save changes?") is the user's decision and is never answered by Claude.
 */

import { winHelper } from '../win/helper.js';

/** Where CE's dialogs are looked for: its process and main window, known once connected. */
export interface CEWindow {
  pid: number;
  main: number;
}

export interface CEDialog {
  id: string;
  title: string;
  /** Texts of its child windows; CE's labels are not windows, their text is only in the image. */
  texts: string[];
  buttons: { id: string; text: string }[];
  /** PNG, base64. */
  image?: string;
}

export function isInformation(dialog: CEDialog): boolean {
  return dialog.buttons.length === 1;
}

export async function listDialogs(win: CEWindow, withImage = false): Promise<CEDialog[]> {
  return winHelper.request<CEDialog[]>({ cmd: 'dialogs', pid: win.pid, main: win.main, image: withImage });
}

/** One line per dialog, with what to do about it. */
export function describeDialogs(dialogs: CEDialog[]): string {
  return dialogs
    .map((d) => {
      const texts = d.texts.length ? `: ${d.texts.join(' | ')}` : '';
      const buttons = d.buttons.map((b) => b.text.replace('&', '') || '?').join(', ');
      const what = isInformation(d)
        ? `information (1 button). Read it with ce_dialogs (its text is in the image), then close it with ce_dialog_close(id="${d.id}")`
        : `a QUESTION for the user (buttons: ${buttons}). Tell the user to answer it in Cheat Engine; never answer it yourself`;
      return `Cheat Engine shows the dialog "${d.title}"${texts} - ${what}`;
    })
    .join('\n');
}

/** Close an information dialog (WM_CLOSE, what its close button does); refuse a question. */
export async function closeInformationDialog(win: CEWindow, id: string): Promise<string> {
  const dialogs = await listDialogs(win);
  const dialog = dialogs.find((d) => d.id === id);
  if (!dialog) {
    return dialogs.length
      ? `Error: no dialog ${id} open in Cheat Engine. Open now:\n${describeDialogs(dialogs)}`
      : `Error: no dialog ${id} open in Cheat Engine (it was closed)`;
  }
  if (!isInformation(dialog)) {
    return `BLOCKED: "${dialog.title}" asks the user a question (${dialog.buttons.length} buttons): only the user answers it, in Cheat Engine`;
  }
  await winHelper.request({ cmd: 'close', id });
  // The dialog's own message loop handles the close: check that it is gone
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await listDialogs(win)).some((d) => d.id === id)) return `Closed the dialog "${dialog.title}"`;
  }
  return `Error: the dialog "${dialog.title}" did not close`;
}
