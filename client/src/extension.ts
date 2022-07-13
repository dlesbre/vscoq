'use strict';
import * as vscode from 'vscode';
import { TextEditor, TextEditorEdit, ExtensionContext } from 'vscode';
import * as proto from './protocol';
import { CoqProject, CoqDocument } from './CoqProject';
import * as snippets from './Snippets';
import { initializeDecorations } from './Decorations';
import * as editorAssist from './EditorAssist';
import * as psm from './prettify-symbols-mode';

vscode.Range.prototype.toString = function rangeToString(this: vscode.Range) { return `[${this.start.toString()},${this.end.toString()})` }
vscode.Position.prototype.toString = function positionToString(this: vscode.Position) { return `{${this.line}@${this.character}}` }

console.log(`Coq Extension: process.version: ${process.version}, process.arch: ${process.arch}}`);

let project: CoqProject;

const regExpCoqNotation = /[^\p{Z}\p{C}"]+/u;

export var extensionContext: ExtensionContext;

export function activate(context: ExtensionContext) {
  console.log(`execArgv: ${process.execArgv.join(' ')}`);
  console.log(`argv: ${process.argv.join(' ')}`);
  extensionContext = context;

  // Indentation rules
  vscode.languages.setLanguageConfiguration("coq", {
    // @Note Literal whitespace in below regexps is removed
    onEnterRules: [
      {
        beforeText: new RegExp(
          String.raw`
          ^\s*
          (
            (\|) .+
          )
          \s*$
          `.replace(/\s+?/g, "")
        ),
        action: {
          indentAction: vscode.IndentAction.None
        }
      },
      {
        beforeText: new RegExp(
          String.raw`
          ^\s*
          (
            (Definition|Fixpoint|Record|Ltac|Let|Notation|Program Definition) .+:=
          )
          \s*$
          `.replace(/\s+?/g, "")
        ),
        action: {
          indentAction: vscode.IndentAction.Indent
        }
      }
    ]
  });

  project = CoqProject.create(context);
  context.subscriptions.push(project);

  function regTCmd(command: string, callback: (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, ...args: any[]) => void) {
    context.subscriptions.push(vscode.commands.registerTextEditorCommand('extension.coq.' + command, callback));
  }
  function regCmd(command: string, callback: (...args: any[]) => any, thisArg?: any) {
    context.subscriptions.push(vscode.commands.registerCommand('extension.coq.' + command, callback, thisArg));
  }
  function regProjectCmd(command: string, callback: (...args: any[]) => any, thisArg?: any) {
    context.subscriptions.push(vscode.commands.registerCommand('extension.coq.' + command, callback, project));
  }

  initializeDecorations(context);

  regProjectCmd('quit', project.quitCoq);
  regProjectCmd('reset', project.resetCoq);
  regProjectCmd('interrupt', project.interruptCoq);
  regProjectCmd('finishComputations', project.finishComputations);
  regProjectCmd('stepForward', project.stepForward);
  regProjectCmd('stepBackward', project.stepBackward);
  regProjectCmd('interpretToPoint', project.interpretToPoint);
  regProjectCmd('interpretToPointSynchronous', () => project.interpretToPoint({ synchronous: true }));
  regProjectCmd('interpretToEnd', project.interpretToEnd);
  regProjectCmd('interpretToEndSynchronous', () => project.interpretToEnd({ synchronous: true }));
  regProjectCmd('moveCursorToFocus', project.setCursorToFocus);
  regTCmd('query.check', check);
  regTCmd('query.locate', locate);
  regTCmd('query.search', search);
  regTCmd('query.about', about);
  regTCmd('query.searchAbout', searchAbout);
  regTCmd('query.print', print);
  regTCmd('query.prompt.check', queryCheck);
  regTCmd('query.prompt.locate', queryLocate);
  regTCmd('query.prompt.search', querySearch);
  regTCmd('query.prompt.about', queryAbout);
  regTCmd('query.prompt.searchAbout', querySearchAbout);
  regTCmd('query.prompt.print', queryPrint);
  regTCmd('proofView.viewStateAt', viewProofStateAt);
  regTCmd('proofView.open', viewCurrentProofState);
  regProjectCmd('ltacProf.getResults', project.ltacProfGetResults);
  regCmd('display.toggle.implicitArguments', () => project.setDisplayOption(proto.DisplayOption.ImplicitArguments, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle.coercions', () => project.setDisplayOption(proto.DisplayOption.Coercions, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle.rawMatchingExpressions', () => project.setDisplayOption(proto.DisplayOption.RawMatchingExpressions, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle.notations', () => project.setDisplayOption(proto.DisplayOption.Notations, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle.allBasicLowLevelContents', () => project.setDisplayOption(proto.DisplayOption.AllBasicLowLevelContents, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle.existentialVariableInstances', () => project.setDisplayOption(proto.DisplayOption.ExistentialVariableInstances, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle.universeLevels', () => project.setDisplayOption(proto.DisplayOption.UniverseLevels, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle.allLowLevelContents', () => project.setDisplayOption(proto.DisplayOption.AllLowLevelContents, proto.SetDisplayOption.Toggle));
  regCmd('display.toggle', () => project.setDisplayOption());

  context.subscriptions.push(editorAssist.reload());
  snippets.setupSnippets(context.subscriptions);
  context.subscriptions.push(psm.load());

  context.subscriptions.push(vscode.languages.registerHoverProvider("coq", {
    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
      // 1. Get text under cursor
      let range = document.getWordRangeAtPosition(position);
      if (!range)
        range = document.getWordRangeAtPosition(position, regExpCoqNotation);
      const text = coqIdOrNotationFromRange(document, range).trim();
      if (text === "") return;

      // 2. Send "Check $text." query to server and await response
      const doc = project.getOrCurrent(document.uri.toString());
      if (!doc) return;
      const response = await doc.hoverQuery(text);
      if (!response) return;

      // 4. Strip output of anything but the type
      // Check a. prints
      // |a
      // |\t : Type
      // |       type (continued if long) (7 space indent)
      // |where
      // |?optional = whatever
      const array = response.split("\nwhere\n");
      let type = array[0];
      // let where = array[1];
      type = type.replace(/^.*?\n\t : /, ""); // remove identifier
      type = type.replace(/^ {7}/gm, ""); // remove indent

      // 5. Format the type to be pretty and compact (e.g. replace forall with ∀)
      const operator_regex = (s:string) => {
        // Matching operators is simple, as Coq will kindly
        // print spaces before/after them
        return new RegExp("(?<=\\s)" + s + "(?=\\s)", "g");
      }
      const replaces = [
        {match:/\bfun\b/g, subst:"λ"},
        {match:/\bforall\b/g, subst:"∀"},
        {match:/\bexists\b/g, subst:"∃"},
        {match:operator_regex("\\\\\\/"), subst:"∨"},
        {match:operator_regex("\\/\\\\"), subst:"∧"},
        {match:operator_regex("<->"), subst:"⟷"}, // the default arrow "↔" is too small/low...
        {match:operator_regex("->"), subst:"➞"}, // the default arrow "→" is too small/low...
        {match:operator_regex("<="), subst:"≤"},
        {match:operator_regex(">="), subst:"≥"},
        // {match:operator_regex("=>"), subst:"⇒"}, // very ugly render
        {match:operator_regex("<>"), subst:"≠"},
        {match:operator_regex("~"), subst:"¬"}
      ];
      for (const replace of replaces) {
        type = type.replace(replace.match, replace.subst);
      }

      if (type === "") return;
      let hover = [{language:"coq", value:type}];
      // if (where)
      //  hover.push({language:"coq", value:where});
      return new vscode.Hover(hover);
    }
  }))
}


async function withDocAsync<T>(editor: TextEditor, callback: (doc: CoqDocument) => Promise<T>): Promise<void> {
  const doc = editor ? project.getOrCurrent(editor.document.uri.toString()) || null : null;
  if (doc)
    await callback(doc);
}

function coqIdOrNotationFromPosition(editor: TextEditor) {
  let range : vscode.Range | undefined = editor.selection;
  if (range.isEmpty)
    range = editor.document.getWordRangeAtPosition(editor.selection.active);
  if (range == undefined)
    range = editor.document.getWordRangeAtPosition(editor.selection.active,regExpCoqNotation);
  return coqIdOrNotationFromRange(editor.document, range);
}

function coqIdOrNotationFromRange(document: vscode.TextDocument, range:vscode.Range|undefined) {
  let text = document.getText(range);
  if (new RegExp("\^"+regExpCoqNotation.source+"\$",regExpCoqNotation.flags).test(text)
      && ! new RegExp("\^"+editorAssist.regExpQualifiedCoqIdent.source+"\$",regExpCoqNotation.flags).test(text))
    return "\""+text+"\"";
  return text;
}

async function queryStringFromPlaceholder(prompt: string, editor: TextEditor) {
  return await vscode.window.showInputBox({
    prompt: prompt,
    value: coqIdOrNotationFromPosition(editor)
  });
}

async function queryStringFromPosition(prompt: string, editor: TextEditor) {
  let query = coqIdOrNotationFromPosition(editor);
  if (query.trim() === "")
    return await vscode.window.showInputBox({
      prompt: prompt,
      value: undefined
    });
  else
    return query;
}

function queryCheck(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("check", await queryStringFromPlaceholder("Check:", editor))
  )
}

function queryLocate(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("locate", await queryStringFromPlaceholder("Locate:", editor))
  )
}

function querySearch(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("search", await queryStringFromPlaceholder("Search:", editor))
  )
}

function queryAbout(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("about", await queryStringFromPlaceholder("Search:", editor))
  )
}

function querySearchAbout(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("searchAbout", await queryStringFromPlaceholder("Search About:", editor))
  )
}

function queryPrint(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("print", await queryStringFromPlaceholder("Print:", editor))
  )
}

function check(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("check", await queryStringFromPosition("Check:", editor))
  )
}

function locate(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("locate", await queryStringFromPosition("Locate:", editor))
  )
}

function search(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("search", await queryStringFromPosition("Search:", editor))
  )
}

function about(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("about", await queryStringFromPosition("Search:", editor))
  )
}

function searchAbout(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("searchAbout", await queryStringFromPosition("Search About:", editor))
  )
}

function print(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.query("print", await queryStringFromPosition("Search About:", editor))
  )
}

function viewProofStateAt(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.viewGoalAt(editor)
  );
}

function viewCurrentProofState(editor: TextEditor, edit: TextEditorEdit) {
  return withDocAsync(editor, async (doc) =>
    doc.viewGoalState(editor)
  )
}
