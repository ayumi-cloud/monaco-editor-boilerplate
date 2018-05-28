/* @flow */

import * as monaco from 'monaco-editor'; // eslint-disable-line import/no-unresolved
import * as React from 'react';
import debounce from 'lodash/debounce';

const WORKER_BASE_URL = 'http://localhost:3021';

global.MonacoEnvironment = {
  getWorkerUrl(moduleId, label) {
    const workers = {
      json: 'json.worker.bundle.js',
      css: 'css.worker.bundle.js',
      html: 'html.worker.bundle.js',
      typescript: 'ts.worker.bundle.js',
      javascript: 'ts.worker.bundle.js',
      default: 'editor.worker.bundle.js',
    };

    return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
      self.MonacoEnvironment = {
        baseUrl: '${WORKER_BASE_URL}'
      };

      importScripts('${WORKER_BASE_URL}/${workers[label] || workers.default}');
    `)}`;
  },
};

export type Annotation = {
  row: number,
  column: number,
  severity: number,
  text: string,
  type: 'error',
  source: string,
};

type Language = 'json' | 'css' | 'html' | 'typescript' | 'javascript';

type Props = {
  path: string,
  value: string,
  onValueChange: (value: string) => mixed,
  annotations: Annotation[],
  language: Language,
  lineNumbers?: 'on' | 'off',
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded',
  scrollBeyondLastLine?: boolean,
  minimap?: {
    enabled?: boolean,
    maxColumn?: number,
    renderCharacters?: boolean,
    showSlider?: 'always' | 'mouseover',
    side?: 'right' | 'left',
  },
};

const models = new Map();
const selections = new Map();

export default class Editor extends React.Component<Props> {
  static defaultProps = {
    lineNumbers: 'on',
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    minimap: {
      enabled: false,
    },
  };

  static removePath(path: string) {
    const model = models.get(path);

    model && model.dispose();
    models.delete(path);

    selections.delete(path);
  }

  static renamePath(prevPath: string, nextPath: string) {
    const model = models.get(prevPath);

    models.delete(prevPath);
    models.set(nextPath, model);

    const selection = selections.get(prevPath);

    selections.delete(prevPath);
    selections.set(nextPath, selection);
  }

  componentDidMount() {
    this._syntaxWorker = new Worker(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(
        `importScripts('${WORKER_BASE_URL}/jsx-syntax.worker.bundle.js');`
      )}`
    );

    this._syntaxWorker.addEventListener('message', ({ data }: any) =>
      this._updateDecorations(data)
    );

    // eslint-disable-next-line no-unused-vars
    const { path, annotations, value, language, ...rest } = this.props;

    this._editor = monaco.editor.create(this._node, rest);
    this._editor.onDidChangeCursorSelection(selectionChange => {
      selections.set(this.props.path, {
        selection: selectionChange.selection,
        secondarySelections: selectionChange.secondarySelections,
      });
    });

    this._openFile(path, value, language);
    this._phantom.contentWindow.addEventListener('resize', this._handleResize);
  }

  componentDidUpdate(prevProps: Props) {
    const { path, annotations, value, language, ...rest } = this.props;

    this._editor.updateOptions(rest);

    if (path !== prevProps.path) {
      this._openFile(path, value, language);
    } else if (value !== this._editor.getModel().getValue()) {
      this._editor.getModel().setValue(value);
      this._sytaxHighlight(path, value, language);
    }

    if (annotations !== prevProps.annotations) {
      monaco.editor.setModelMarkers(
        this._editor.getModel(),
        null,
        annotations.map(annotation => ({
          startLineNumber: annotation.row,
          endLineNumber: annotation.row,
          startColumn: annotation.column,
          endColumn: annotation.column,
          message: annotation.text,
          severity: annotation.severity,
          source: annotation.source,
        }))
      );
    }
  }

  componentWillUnmount() {
    this._subscription && this._subscription.dispose();
    this._editor.dispose();
    this._syntaxWorker.terminate();
    this._phantom.contentWindow.removeEventListener(
      'resize',
      this._handleResize
    );
  }

  clearSelection() {
    const selection = this._editor.getSelection();

    this._editor.setSelection(
      new monaco.Selection(
        selection.startLineNumber,
        selection.startColumn,
        selection.startLineNumber,
        selection.startColumn
      )
    );
  }

  _openFile = (path: string, value: string, language: Language) => {
    let model = models.get(path);

    if (!model) {
      model = monaco.editor.createModel(value, language, path);
      models.set(path, model);
    }

    this._editor.setModel(model);

    const selection = selections.get(path);

    if (selection) {
      this._editor.setSelection(selection.selection);

      if (selection.secondarySelections.length) {
        this._editor.setSelections(selection.secondarySelections);
      }
    }

    this._editor.focus();

    this._subscription && this._subscription.dispose();
    this._subscription = this._editor.getModel().onDidChangeContent(() => {
      this.props.onValueChange(this._editor.getModel().getValue());
      this._sytaxHighlight(path, value, language);
    });

    this._sytaxHighlight(path, value, language);
  };

  _sytaxHighlight = (path, code, language) => {
    if (language === 'typescript' || language === 'javascript') {
      this._syntaxWorker.postMessage({
        code,
        title: path,
        version: this._editor.getModel().getVersionId(),
      });
    }
  };

  _updateDecorations = ({ classifications, version }: any) => {
    requestAnimationFrame(() => {
      const model = this._editor.getModel();

      if (model && model.getVersionId() === version) {
        const decorations = classifications.map(classification => ({
          range: new monaco.Range(
            classification.startLine,
            classification.start,
            classification.endLine,
            classification.end
          ),
          options: {
            inlineClassName: classification.type
              ? `${classification.kind} ${classification.type}-of-${
                  classification.parentKind
                }`
              : classification.kind,
          },
        }));

        const model = this._editor.getModel();

        model.decorations = this._editor.deltaDecorations(
          model.decorations || [],
          decorations
        );
      }
    });
  };

  _handleResize = debounce(() => this._editor.layout(), 100, {
    leading: true,
    trailing: true,
  });

  _syntaxWorker: Worker;
  _subscription: any;
  _editor: any;
  _phantom: any;
  _node: any;

  render() {
    return (
      <div
        style={{
          display: 'flex',
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <iframe
          ref={c => (this._phantom = c)}
          type="text/html"
          style={{
            display: 'block',
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            width: '100%',
            pointerEvents: 'none',
            opacity: 0,
          }}
        />
        <div
          ref={c => (this._node = c)}
          style={{ display: 'flex', flex: 1, overflow: 'hidden' }}
        />
      </div>
    );
  }
}
