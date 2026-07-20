import { createEffect, onCleanup, onMount } from "solid-js";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  search,
  SearchQuery,
  setSearchQuery,
  findNext,
} from "@codemirror/search";

export default function YamlEditor(props: {
  value: string;
  theme: "dark" | "light";
  query?: string;
  readOnly?: boolean;
  onChange: (v: string) => void;
  onLeave?: () => void;
  onFind?: () => void;
  api?: (a: { next: () => void; focus: () => void }) => void;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const themeComp = new Compartment();

  const themeExt = (t: "dark" | "light") => (t === "dark" ? oneDark : []);

  onMount(() => {
    view = new EditorView({
      doc: props.value,
      extensions: [
        // Esc / ctrl+] hand focus back to the panel, ahead of the
        // default keymaps so the editor never traps the user.
        Prec.highest(
          keymap.of([
            {
              key: "Escape",
              run: () => {
                view?.contentDOM.blur();
                props.onLeave?.();
                return true;
              },
            },
            {
              // the panel's find box, reachable from inside the editor
              key: "Mod-f",
              run: () => {
                view?.contentDOM.blur();
                props.onFind?.();
                return true;
              },
            },
            {
              key: "Ctrl-]",
              run: () => {
                view?.contentDOM.blur();
                props.onLeave?.();
                return true;
              },
            },
          ]),
        ),
        basicSetup,
        yaml(),
        search(),
        themeComp.of(themeExt(props.theme)),
        // Records like Events are shown, never edited.
        EditorState.readOnly.of(!!props.readOnly),
        EditorView.editable.of(!props.readOnly),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) props.onChange(u.state.doc.toString());
        }),
      ],
      parent: host,
    });
    props.api?.({
      next: () => {
        if (view) findNext(view);
      },
      focus: () => {
        host.scrollIntoView({ block: "start", behavior: "smooth" });
        view?.focus();
      },
    });
  });

  // External resets (Reset button, new resource opened) flow back in.
  createEffect(() => {
    const v = props.value;
    if (view && view.state.doc.toString() !== v) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: v },
      });
    }
  });

  createEffect(() => {
    const t = props.theme;
    view?.dispatch({ effects: themeComp.reconfigure(themeExt(t)) });
  });

  // Drive match highlighting from the drawer's find box.
  createEffect(() => {
    const q = props.query ?? "";
    view?.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: q, caseSensitive: false }),
      ),
    });
  });

  onCleanup(() => view?.destroy());
  return <div class="yaml-editor" ref={host} />;
}
