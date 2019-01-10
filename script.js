class Script {
  constructor() {
    this.projectID = localStorage.getItem(ACTIVE_PROJECT_KEY)|0;
    this.queuedTransations = [];

    this.BuiltIns = new BuiltIns();

    this.lines = [];

    function decodeData(script) {
      this.getAll().onsuccess = function(event) {
        const scriptData = event.target.result;
        const varDefs = new Map();
        let highestVarId = -1;
        
        for (const lineData of scriptData) {
          const items = [];

          for (const data of lineData.items || []) {
            if ("type" in data) {
              const type = script.BuiltIns.TYPES.find(type => type.id === data.type);
              const scope = script.BuiltIns.VOID;
              const id = data.id;
              highestVarId = Math.max(id, highestVarId);
              const typeAnnotated = data.typeAnnotated;
              const varDef = new VarDef(data.name, type, {scope, id, typeAnnotated});
              items.push(varDef);
              varDefs.set(data.id, varDef);
            } else if ("varDef" in data) {
              const varDef = varDefs.get(data.varDef);
              if (varDef) {
                const currentscope = script.BuiltIns.VOID;
                items.push(new VarRef(varDef, currentscope));
              } else {
                items.push(script.BuiltIns.PLACEHOLDER);
              }
            } else if ("argIndex" in data) {
              const funcDef = script.BuiltIns.FUNCTIONS[-1 - data.funcDef];
              items.push(new ArgHint(funcDef, data.argIndex));
            } else if ("funcDef" in data) {
              const funcDef = script.BuiltIns.FUNCTIONS[-1 - data.funcDef];
              const currentscope = script.BuiltIns.VOID;
              items.push(new FuncRef(funcDef, currentscope));
            } else if ("symbol" in data) {
              items.push(script.BuiltIns.SYMBOLS[data.symbol]);
            } else if ("keyword" in data) {
              items.push(script.BuiltIns.KEYWORDS[data.keyword]);
            } else if ("numLit" in data) {
              items.push(new NumericLiteral(data.numLit));
            } else if ("boolLit" in data) {
              items.push(data.boolLit ? script.BuiltIns.TRUE : script.BuiltIns.FALSE);
            } else if ("strLit" in data) {
              items.push(new StringLiteral(data.strLit));
            } else if ("loopLayers" in data) {
              items.push(new LoopLabel(data.loopLayers));
            } else {
              console.log(data, "not recognized during loading")
            }
          }

          script.lines.push({
            key: lineData.key,
            indent: lineData.indent|0,
            items,
          });
        }

        VarDef.nextId = highestVarId + 1;

        scriptLoaded();
      }
    }

    performActionOnProjectListDatabase("readonly", (objStore, transaction) => {
      objStore.get(this.projectID).onsuccess = (event) => {
        if (!event.target.result) {
          console.log("The previously opened project no longer exists");
          localStorage.removeItem(ACTIVE_PROJECT_KEY);
          scriptLoaded();
        } else {
          this.performTransactions("readonly", [{func: decodeData, args: [this]}]);
        }
      }
    });
  }

  insertFuncCall(row, col, func) {
    const items = [new FuncRef(func, this.BuiltIns.VOID)];
    for (let i = 0; i < func.signature.parameters.length; ++i) {
      items.push(this.BuiltIns.ARG_SEPARATOR, new ArgHint(func, i));
    }
    items[1] = this.BuiltIns.BEGIN_ARGS;
    items.push(this.BuiltIns.END_ARGS);

    this.appendLinesUpTo(row);
    this.spliceLine(row, col, 1, ...items);
    this.runTypeInference(row);
    return {lineUpdated: true, selectedCol: col + 2};
  }

  itemClicked(row, col) {
    if (col < 0) {
      const options = this.appendClicked(row);
      if (options) {
        return options;
      }
      col = this.getItemCount(row);
    }

    const options = [];

    const item = this.getItem(row, col) || {};
    const nextItem = this.getItem(row, col + 1) || {};

    const replace = (col, item) => {
      this.setItem(row, col, item);
      this.runTypeInference(row);
      return {lineUpdated: true};
    };

    const insert = (col, ...items) => {
      this.spliceLine(row, col, 0, ...items);
      this.runTypeInference(row);
      return {lineUpdated: true, selectedCol: col + 1};
    };

    const setVarRef = (varDef) => {
      return replace(col, new VarRef(varDef, this.BuiltIns.VOID));
    };

    if (item.suggestion) {
      const isAssignment = this.getItem(row, 2) && this.getItem(row, 2).isAssignment;
      if (item !== this.BuiltIns.VAR || isAssignment) {
        const [text, style] = item.suggestion.getDisplay();
        options.push({text, style, action: replace, args: [col, item.suggestion]});
      }
    }

    if (col === 1 && item.isAssignment) {
      for (const op of this.BuiltIns.SYMBOLS.filter(sym => sym.isAssignment)) {
        const [text, style] = op.getDisplay();
        options.push({text, style, action: replace, args: [col, op]});
      }
    }

    if (item.isRange) {
      for (const op of this.BuiltIns.SYMBOLS.filter(sym => sym.isRange)) {
        const [text, style] = op.getDisplay();
        options.push({text, style, action: replace, args: [col, op]});
      }
      return options;
    }
    
    if (item.constructor === FuncSig || item.constructor === VarDef) {
      const style = (item.constructor === FuncSig) ? "funcdef" : "vardef";
      options.push({
        text: item.name, style, isInput: true, onsubmit: (text) => {
          item.name = text;
          return {scriptChanged: true};
        }
      });
    }

    if (col === 0) {
      if (item.constructor === VarRef) {
        options.push(...this.getVisibleVars(row, true, setVarRef));
      } else if (item.constructor === FuncRef) {
        //options.push(...this.getFunctionList(false));
      } else if (item === this.BuiltIns.IF) {
        const indent = this.getIndent(row);
        for (let r = row - 1; r >= 0; --r) {
          if (this.getIndent(r) < indent)
            break;

          if (this.getItem(r, 0) === this.BuiltIns.IF
          || this.getItem(r, 1) === this.BuiltIns.IF) {
            options.push({text: "else", style: "keyword",
              action: insert, args: [col, this.BuiltIns.ELSE]
            });
            break;
          }
        }
      }
    } else {
      if (item === this.BuiltIns.BEGIN_EXPRESSION
      || item === this.BuiltIns.END_EXPRESSION) {
        options.push({text: "", style: "delete-outline", action: () => {
          const [start, end] = this.getExpressionBounds(row, col);
          this.spliceLine(row, end, 1);
          this.spliceLine(row, start, 1);
          return {lineUpdated: true, selectedCol: col === start ? col : col - 2};
        }});
      }

      //allow the user to enter additional arguments for variadic functions
      if ([this.BuiltIns.ARG_SEPARATOR, this.BuiltIns.END_ARGS].includes(nextItem)) {
        //find signiture of function this argument belongs to
        let depth = 0;
        for (let i = col - 1; i >= 0; --i) {
          const item = this.getItem(row, i);
          if (item === this.BuiltIns.END_ARGS) {
            ++depth;
          } else if (item === this.BuiltIns.BEGIN_ARGS) {
            --depth;
            if (depth === -1) {
              const func = this.getItem(row, i - 1).funcDef;
              //TODO make sure function is actually variadic
              options.push({text: ",", action: insert,
                args: [col + 1, this.BuiltIns.ARG_SEPARATOR, new ArgHint(func, 0)]
              });
            }
          }
        }
      }
      
      const wrapInParens = {
        text: "( )", action: () => {
        const [start, end] = this.getExpressionBounds(row, col);
        this.spliceLine(row, end + 1, 0, this.BuiltIns.END_EXPRESSION);
        this.spliceLine(row, start, 0, this.BuiltIns.BEGIN_EXPRESSION);
        return {lineUpdated: true, selectedCol: col + 1};
      }};

      if (item.constructor === FuncRef
      || item.direction === 1) {
        options.push(wrapInParens);
      }
      
      if (item.constructor === FuncSig) {
        const setReturnType = (type, item) => {
          item.returnType = type;
          this.saveLines([this.lines[row]]);
          return {lineUpdated: true};
        };
        
        options.push({text: "void", style: "comment",
          action: setReturnType, args: [item, this.BuiltIns.ANY]
        });
        
        options.push(...this.getSizedTypes(setReturnType, item));
      }

      if (item.constructor === VarDef) {
        const setType = (type, item) => {
          if (type === this.BuiltIns.ANY) {
            item.typeAnnotated = false;
            this.runTypeInference(row);
          } else {
            item.typeAnnotated = true;
            item.type = type;
          }
          
          this.saveLines([this.lines[row]]);
          return {lineUpdated: true};
        }
        
        if (this.getItemCount(row) > 2
        && (
          this.getItem(row, col + 1).isAssignment)
          || this.getItem(row, col + 1) === this.BuiltIns.IN
        ) {
          options.push({text: "auto", style: "comment",
            action: setType, args: [this.BuiltIns.ANY, item]
          });
        }

        //indicate what the current type is within the type options
        const typeOptions = this.getSizedTypes(setType, item);
        const index = typeOptions.findIndex(op => op.args[0] === item.type);
        if (index !== -1) {
          typeOptions[index].isSelected = true;
        }
        options.push(...typeOptions);
      }

      const prevItem = this.getItem(row, col - 1);
      
      if (prevItem === this.BuiltIns.CONTINUE || prevItem === this.BuiltIns.BREAK) {
        //count the number of nested loops this statement is inside
        let loopStructureCount = 0;

        let indent = this.getIndent(row);
        for (let r = row - 1; r >= 0; --r) {
          const lineIndent = this.getIndent(r);
          if (lineIndent < indent) {
            indent = lineIndent;
            if (this.getItem(r, 0) === this.BuiltIns.WHILE
            || this.getItem(r, 0) === this.BuiltIns.DO_WHILE
            || this.getItem(r, 0) === this.BuiltIns.FOR) {
              ++loopStructureCount;
            }
          }
        }

        for (let layer = 2; layer <= loopStructureCount; ++layer) {
          const item = new LoopLabel(layer);
          const [text, style] = item.getDisplay();
          options.push({text, style,
            action: replace, args: [col, item]
          });
        }
      }

      if (prevItem.preceedsExpression
      || prevItem === this.BuiltIns.RETURN && this.getReturnType(row)) {
        if (!item.isUnary) {
          let text = "";
          let style = "";
          if ([NumericLiteral, BooleanLiteral].includes(item.constructor)) {
            [text, style] = item.getDisplay();
          }
          if (item.constructor === StringLiteral) {
            [text, style] = [item.text, "string literal"];
            if (text === "true" || text === "false" || !isNaN(text)) {
              text = '"' + text + '"';
            }
          }
          options.push(
            {text, isInput: true, style, hint: "literal", onsubmit: (text) => {
              let newItem;

              if (text.toLowerCase() === "true") {
                newItem = this.BuiltIns.TRUE;
              } else if (text.toLowerCase() === "false") {
                newItem = this.BuiltIns.FALSE;
              } else if (text.trim().length !== 0 && !isNaN(text)) {
                newItem = new NumericLiteral(text.trim());
              } else {
                if (text.startsWith('"'))
                  text = text.substring(1);
                
                if (text.endsWith('"'))
                  text = text.substring(0, text.length - 1);

                newItem = new StringLiteral(text);
              }

              return replace(col, newItem);
            }, oninput: (event) => {
              const inputNode = event.target;
              inputNode.classList.remove("keyword", "number", "string");
              if (/^(true|false)$/i.test(inputNode.value)) {
                inputNode.classList.add("keyword");
              } else if (!isNaN(inputNode.value)) {
                inputNode.classList.add("number");
              } else {
                inputNode.classList.add("string");
              }
            }},
          );
        }

        if (!prevItem.isUnary) {
          const action = (item.constructor === Symbol && item !== this.BuiltIns.PLACEHOLDER) ? replace : insert;
          for (const op of this.BuiltIns.SYMBOLS.filter(sym => sym.isUnary)) {
            options.push({text: op.text + " ___", action, args: [col, op]});
          }
        }

        options.push(...this.getVisibleVars(row, false, setVarRef));

        let type = this.BuiltIns.ANY;
        if (row < this.lineCount) {
          if (this.getItemCount(row) > 0 && this.getItem(row, 0).constructor === VarRef) {
            type = this.getItem(row, 0).varDef.type;
          }
          else if (this.getItemCount(row) > 1 && this.getItem(row, 1).constructor === VarDef) {
            type = this.getItem(row, 1).type;
          }
        }

        let funcs = this.BuiltIns.FUNCTIONS;
        if (type !== this.BuiltIns.ANY) {
          funcs = funcs.filter(func => {
            return func.signature.returnType === type
            || type.casts && type.casts.get(func.signature.returnType);
          });
        }
        const scopes = new Set(funcs.map(func => func.signature.scope));
          
        const style = "keyword";
        const action = this.getVisibleFuncs;

        for (const scope of scopes) {
          options.push({text: scope.text, style, action, args: [row, col, scope, type]});
        }
      }

      let binOps = this.BuiltIns.SYMBOLS.filter(sym => sym.isBinary);
      if (this.getItem(row, 1) === this.BuiltIns.IF
      || [this.BuiltIns.IF, this.BuiltIns.WHILE, this.BuiltIns.DO_WHILE].includes(this.getItem(row, 0))) {
        //TODO generalize this to when a boolean return type, argument, or variable type is expected
        binOps = [...binOps.filter(op => op.isBool), ...binOps.filter(op => !op.isBool)];
      }
      
      if (item.constructor === VarRef
      || item.constructor === NumericLiteral
      || item === this.BuiltIns.END_EXPRESSION
      || item === this.BuiltIns.END_ARGS) {
        options.push(wrapInParens);
        const isAppending = (col === this.getItemCount(row) - 1);

        for (const op of binOps) {
          const args = [col + 1, op];
          if (!isAppending) {
            args.push(this.BuiltIns.PLACEHOLDER);
          }

          options.push({text: op.text, action: insert, args});
        };
      }
      
      if (prevItem.constructor === VarRef
      || prevItem.constructor === NumericLiteral
      || prevItem === this.BuiltIns.END_EXPRESSION
      || prevItem === this.BuiltIns.END_ARGS) {
        for (const op of binOps) {
          options.push({text: op.text, action: replace, args: [col, op]});
        }
      }

      if (item !== this.BuiltIns.IF && prevItem === this.BuiltIns.ELSE) {
        options.push({text: "if", style: "keyword", action: () => {
          this.pushItems(row, this.BuiltIns.IF);
          return {lineUpdated: true};
        }});
      }
    }

    return options;
  }

  appendClicked(row) {
    const rowCount = this.lineCount;
    const itemCount = (row < rowCount) ? this.getItemCount(row) : 0;

    if (itemCount === 0) {
      let indent = (row < rowCount) ? this.getIndent(row) : 0;

      const options = [
        {
          text: "print", style: "funcdef", action: this.insertFuncCall,
          args: [row, 0, this.BuiltIns.PRINT]
        },

        // {text: "fn", style: "keyword", action: () => {
        //   const func = new FuncSig(this.BuiltIns.VOID, "myFunc", this.BuiltIns.VOID);
        //   this.appendRowsUpTo(row);
        //   this.pushItems(row, this.BuiltIns.FUNC, func);
        //   return {lineUpdated: true, lineInserted: true, selectedCol: 1};
        // }},

        {text: "var", style: "keyword", action: () => {
          this.appendLinesUpTo(row);
          this.pushItems(row,
            this.BuiltIns.VAR,
            new VarDef(null, this.BuiltIns.ANY),
            this.BuiltIns.ASSIGN
          );
          return {lineUpdated: true, selectedCol: 1};
        }},

        {text: "if", style: "keyword", action: () => {
          this.appendLinesUpTo(row);
          this.pushItems(row, this.BuiltIns.IF);
          return {lineUpdated: true, lineInserted: true};
        }}
      ];

      //scan backward looking for an if block at the same indent level
      for (let r = Math.min(rowCount, row) - 1; r >= 0; --r) {
        if (this.getIndent(r) < indent)
          break;

        if (this.getIndent(r) === indent) {
          if (this.getItem(r, 0) === this.BuiltIns.IF
          || this.getItem(r, 1) === this.BuiltIns.IF) {
            //scan forward for an else block at the same indent
            for (let r = row + 1; r < rowCount; ++r) {
              if (this.getIndent(r) < indent)
                break;

              if (this.getIndent(r) === indent) {
                if (this.getItem(r, 0) === this.BuiltIns.ELSE) {
                  return [
                    {text: "else if", style: "keyword", action: () => {
                      this.appendLinesUpTo(row);
                      this.pushItems(row, this.BuiltIns.ELSE, this.BuiltIns.IF);
                      return {lineUpdated: true, lineInserted: true};
                    }}
                  ];
                }
              }
            }

            //if no succeeding else block is found, allow the user to create one
            options.push({text: "else", style: "keyword", action: () => {
              this.appendLinesUpTo(row);
              this.pushItems(row, this.BuiltIns.ELSE);
              return {lineUpdated: true, lineInserted: true};
            }});
            break;
          }
        }
      }

      options.push(
        {text: "for", style: "keyword", action: () => {
          this.appendLinesUpTo(row);
          this.pushItems(row,
            this.BuiltIns.FOR,
            new VarDef("index", this.BuiltIns.I32),
            this.BuiltIns.IN,
            new NumericLiteral("0"),
            this.BuiltIns.HALF_OPEN_RANGE
          );
          return {lineUpdated: true, lineInserted: true};
        }},

        {text: "while", style: "keyword", action: () => {
          this.appendLinesUpTo(row);
          this.pushItems(row, this.BuiltIns.WHILE);
          return {lineUpdated: true, lineInserted: true};
        }},

        {text: "return", style: "keyword", action: () => {
          this.appendLinesUpTo(row);
          this.pushItems(row, this.BuiltIns.RETURN);
          return {lineUpdated: true};
        }}
      );

      for (let r = Math.min(rowCount, row) - 1; r >= 0; --r) {
        const lineIndent = this.getIndent(r);
        if (lineIndent < indent) {
          indent = lineIndent;
          if (this.getItem(r, 0) === this.BuiltIns.WHILE
          || this.getItem(r, 0) === this.BuiltIns.DO_WHILE
          || this.getItem(r, 0) === this.BuiltIns.FOR) {
            options.push(
              {text: "break", style: "keyword", action: () => {
                this.pushItems(row, this.BuiltIns.BREAK);
                return {lineUpdated: true};
              }},
            );
            break;
          }
        }
      }

      options.push(...this.getVisibleVars(row, true, (varDef) => {
        this.appendLinesUpTo(row);
        this.pushItems(row,
          new VarRef(varDef, this.BuiltIns.VOID),
          this.BuiltIns.ASSIGN
        );
        return {lineUpdated: true};
      }));

      const scopes = new Set(this.BuiltIns.FUNCTIONS.map(func => func.signature.scope));
      const style = "keyword";
      const action = this.getVisibleFuncs;
      for (const scope of scopes) {
        options.push({text: scope.text, style, action, args: [row, 0, scope, this.BuiltIns.ANY]});
      }

      return options;
    }
    
    const defineVar = (type) => {
      const newVar = new VarDef(null, type);
      this.pushItems(row, newVar);
      return {lineUpdated: true};
    }

    if (this.getItem(row, 0) === this.BuiltIns.VAR) {
      if (itemCount === 2) {
        return [
          {text: "=", action: () => {
            this.pushItems(row, this.BuiltIns.ASSIGN);
            return {lineUpdated: true};
          }},
          ...this.getSizedTypes(defineVar)
        ];
      }

      if (this.getItem(row, itemCount - 1).constructor === VarDef) {
        return this.getSizedTypes(defineVar);
      }
    }

    if (this.getItem(row, 0) === this.BuiltIns.FOR) {
      const lastItem = this.getItem(row, this.getItemCount(row) - 1);
      if (lastItem.constructor !== Symbol && !this.lines[row].items.includes(this.BuiltIns.STEP)) {
        return [{text: "step", style: "keyword", action: () => {
          this.pushItems(row, this.BuiltIns.STEP);
          return {lineUpdated: true};
        }}];
      }
    }

    if (this.getItem(row, 0) === this.BuiltIns.FUNC) {
      return this.getSizedTypes(defineVar);
    }

    return null;
  }

  getReturnType(row) {
    for (let r = row - 1; r >= 0; --r) {
      if (this.getItem(r, 0) === this.BuiltIns.FUNC) {
        return this.getItem(r, 1).returnType;
      }
    }

    return undefined;
  }

  /**
   * Finds the bounds of the smallest expression that contains the item position
   * @param {Number} row
   * @param {Number} col
   * @return {[Number, Number]} [startItem, endItem]
   */
  getExpressionBounds(row, col) {
    let start = col;
    let end = col;

    if (this.getItem(row, col).constructor === FuncRef) {
      ++end;
    }

    const symbol = this.getItem(row, end);
    const matchingSymbol = symbol.matching;
    const step = symbol.direction|0;

    if (step !== 0) {
      let matchingIndex = end;
      let depth = 0;
      while (matchingIndex > 0 && matchingIndex < this.getItemCount(row)) {
        if (this.getItem(row, matchingIndex) === symbol) {
          ++depth;
        }

        if (this.getItem(row, matchingIndex) === matchingSymbol) {
          --depth;
          if (depth === 0)
            break;
        }

        matchingIndex += step;
      }

      if (step < 0) {
        start = matchingIndex;
      } else {
        end = matchingIndex;
      }
    }

    if (start > 0 && this.getItem(row, start - 1).constructor === FuncRef) {
      --start;
    }

    return [start, end];
  }

  appendLinesUpTo(row) {
    let oldLength = this.lineCount;

    let key = new Uint8Array((oldLength > 0) ? this.lines[oldLength - 1].key : 1);
    while (row >= this.lineCount) {
      key = Script.getNextKey(key);
      this.lines.push({
        items: [],
        key: key.buffer,
        indent: 0
      });
    }

    if (oldLength !== this.lineCount) {
      this.saveLines(this.lines.slice(oldLength));
    }
  }

  getInsertIndent(row) {
    let indent = 0;
    if (row > 0 && row <= this.lineCount) {
      indent = this.getIndent(row - 1) + this.isStartingScope(row - 1);
      if (this.getItemCount(row - 1) === 0) {
        indent = Math.max(indent - 1, this.getIndent(row));
      }
    }
    return indent;
  }

  canInsert(row) {
    return row < this.lineCount || this.getInsertIndent(row) > 0;
  }

  insertLine(row) {
    if (!this.canInsert(row)) {
      return -1;
    }

    const indent = this.getInsertIndent(row);
    let key;

    //find the best place to insert a line to minimize key size
    //moving the insertion within equally indented blank lines is unnoticable
    for (let end = row ;; ++end) {
      if (end >= this.lineCount) {
        //end of script found, append a line instead
        if (indent === 0) {
          //don't allow trailing whitespace
          return -1;
        }

        const lowKey = new Uint8Array(this.lines[end - 1].key);
        key = Script.getNextKey(lowKey);
        row = end;
        break;
      }
      
      if (this.getIndent(end) !== indent || this.getItemCount(end) !== 0) {
        let begin = row;
        while (begin > 0
          && this.getIndent(begin - 1) === indent
          && this.getItemCount(begin - 1) === 0) {
          --begin;
        }
  
        let bestScore = 0x7FFFFFFF;
        for (let i = begin; i <= end; ++i) {
          const lowKey = new Uint8Array((i > 0) ? this.lines[i - 1].key : 1);
          const highKey = new Uint8Array(this.lines[i].key);
          const avgKey = Script.getAvgKey(lowKey, highKey);
          const last = avgKey.length - 1;
          const score = last * 256 + (lowKey[last] || 0) - avgKey[last];
  
          if (score < bestScore) {
            row = i;
            key = avgKey;
            bestScore = score;
          }
        }
        break;
      }
    }

    const line = {
      items: [],
      key: key.buffer,
      indent
    };
    this.lines.splice(row, 0, line);
    this.saveLines([line]);
    return row;
  }

  deleteLine(row, keepLine = false) {
    if (row >= this.lineCount) {
      return 1;
    }

    const indent = this.getIndent(row);
    let r = row;
    do {
      ++r;
    } while (r < this.lineCount && this.getIndent(r) > indent);
    let count = r - row;

    //manage orphaned else and else if structures
    if (this.getItem(row, 0) === this.BuiltIns.IF
    || this.getItem(row, 1) === this.BuiltIns.IF) {
      while (r < this.lineCount && !this.isStartingScope(r)) {
        ++r;
      }
      if (r < this.lineCount) {
        if (this.getItem(row, 0) === this.BuiltIns.IF) {
          if (this.getItem(r, 1) === this.BuiltIns.IF) {
            this.spliceLine(r, 0, 1);
          }
          else if (this.getItem(r, 0) === this.BuiltIns.ELSE) {
            this.spliceLine(r, 0, 1, this.BuiltIns.IF, this.BuiltIns.TRUE);
          }
        }
      }
    }

    //trim whitespace off the bottom of the script
    let startRow = row;
    if (row + count === this.lineCount) {
      while (startRow > 0 && this.getIndent(startRow - 1) === 0 && this.getItemCount(startRow - 1) === 0) {
        --startRow;
      }
      count = r - startRow;
    }

    //Pressing backspace on a scope starter clears the line and its body, but keeps
    //the line itself.  If it is at the end of the script, it is trimmed as whitespace.
    if ((indent > 0 || startRow + count !== this.lineCount) && keepLine) {
      this.spliceLine(startRow, 0, this.getItemCount(startRow));
      ++startRow;
      --count;
    }

    if (count > 0) {
      const keyRange = IDBKeyRange.bound(this.lines[startRow].key, this.lines[startRow + count - 1].key);
      this.queueTransation(IDBObjectStore.prototype.delete, keyRange);
  
      this.lines.splice(startRow, count);
    }

    return count - (row - startRow);
  }

  deleteItem(row, col) {
    if (this.getItemCount(row) === 0) {
      return {lineDeleted: true};
    }

    let selCol = col;
    if (col === -1) {
      if (row < this.lineCount) {
        selCol = this.getItemCount(row);
        col = selCol - 1;
      } else {
        col = selCol = 0;
      }
    }
    const item = this.getItem(row, col) || {};

    if ((col === 0 && item !== this.BuiltIns.ELSE)
    || (col > 0 && item.constructor === Keyword && item !== this.BuiltIns.IF && item !== this.BuiltIns.STEP)
    || item.constructor === FuncSig
    || item.isAssignment && this.getItem(row, 0) === this.BuiltIns.LET
    || (item.constructor === VarDef
      && (this.getItem(row, col + 1) || {}).isAssignment )
      || this.getItemCount(row) === 2)
    {
      const oldLineCount = this.lineCount;
      this.deleteLine(row, true);

      return this.lineCount === oldLineCount ? {lineUpdated: true, selectedCol: 0x7FFFFF} : {scriptChanged: true};
    }

    if (item.isUnary
    || (col === this.getItemCount(row) - 1 && item === this.BuiltIns.PLACEHOLDER)
    || item.constructor === VarDef) {
      this.spliceLine(row, col, 1);
      return {lineUpdated: true, selectedCol: selCol - 1};
    }
    else if (item.isBinary) {
      const nextItem = this.getItem(row, col + 1) || {};
      const delCount = 2 + (nextItem.isUnary|0);
      this.spliceLine(row, col, delCount);
      return {lineUpdated: true, selectedCol: selCol - 1};
    }
    else if (item === this.BuiltIns.PLACEHOLDER) {
      const prevItem = this.getItem(row, col - 1);
      if (prevItem.isBinary) {
        this.spliceLine(row, col - 1, 2);
        return {lineUpdated: true, selectedCol: selCol - 2};
      } else if (prevItem.isUnary) {
        this.spliceLine(row, col - 1, 1);
        return {lineUpdated: true, selectedCol: selCol - 1};
      } else if (prevItem === this.BuiltIns.ARG_SEPARATOR) {
        this.spliceLine(row, col - 1, 2);
        return {lineUpdated: true, selectedCol: selCol - 1};
      }
      console.trace();
      throw "unhandled placeholder delection";
    }
    else if (item === this.BuiltIns.IF) {
      this.spliceLine(row, col, this.getItemCount(row) - col);
      return {lineUpdated: true, selectedCol: 0};
    }
    else {
      const [start, end] = this.getExpressionBounds(row, col);

      //assumes any selection that reaches the first item spans the whole line
      if (start === 0) {
        if (this.getIndent(row) === 0 && row + 1 === this.lineCount) {
          return {lineDeleted: true};
        } else {
          this.spliceLine(row, start, end - start + 1);
        }
      } else {
        let paramIndex = 0;
        let func;

        const nextItem = this.getItem(row, end + 1);
        const prevItem = this.getItem(row, start - 1);
        if ((nextItem === this.BuiltIns.ARG_SEPARATOR || nextItem === this.BuiltIns.END_ARGS)
        && (prevItem === this.BuiltIns.ARG_SEPARATOR || prevItem === this.BuiltIns.BEGIN_ARGS)) {
          for (let c = start - 1; c > 0; --c) {
            const item = this.getItem(row, c);
            if (item.constructor === FuncRef) {
              func = item;
              break;
            }

            if (this.getItem(row, c) === this.BuiltIns.ARG_SEPARATOR) {
              ++paramIndex;
            }
          }
        }

        if (func) {
          if (func === this.BuiltIns.PRINT) {
            //when removing an argument to print, just delete the argument since it's just an Any[] paramater
            if (paramIndex > 0) {
              this.spliceLine(row, col - 1, 2);
              return {lineUpdated: true, selectedCol: selCol - 2};
            }
            if (paramIndex === 0 && this.getItem(row, col + 1) === this.BuiltIns.ARG_SEPARATOR) {
              this.spliceLine(row, col, 2);
              return {lineUpdated: true};
            }
          }
          this.spliceLine(row, start, end - start + 1, new ArgHint(func, paramIndex));
        } else {
          if (end + 1 === this.getItemCount(row)) {
            this.spliceLine(row, start, end - start + 1);
            return {lineUpdated: true, selectedCol: 0x7FFFFFFF};
          } else {
            this.spliceLine(row, start, end - start + 1, this.BuiltIns.PLACEHOLDER);
          }
        }
      }
      return {lineUpdated: true, selectedCol: start};
    }

    console.trace();
    throw "Reached bottom of DELETE_ITEM without hitting a case";
  }

  saveLines(lines) {
    this.queueTransation(function(lines) {
      for (const line of lines) {
        const serialized = {key: line.key};
        if (line.items.length > 0) {
          serialized.items = line.items.map(item => item.serialize());
        }
        if (line.indent) {
          serialized.indent = line.indent;
        }
        this.put(serialized);
      }
    }, lines);
  }

  /**
   * gets shortest key that sorts immediately after a key
   * @param {Uint8Array} key
   * @returns {Uint8Array} succeeding key
   */
  static getNextKey(key) {
    for (let i = 0; i < key.length; ++i) {
      if (key[i] < 255) {
        const newKey = key.slice(0, i + 1);
        ++newKey[i];
        return newKey;
      }
    }

    return Uint8Array.of(...key, 1);
  }

  /**
   * gets the shortest key that sorts between two keys
   * if lowKey and highKey are identical, returns a clone of lowKey
   * @param {Uint8Array} lowKey
   * @param {Uint8Array} highKey
   * @return {Uint8Array} rounded average key
   */
  static getAvgKey(lowKey, highKey) {
    let diff = 0;
    for (let i = 0; i < Math.max(lowKey.length, highKey.length) + 1; ++i) {
      diff = diff * 256 + (highKey[i]|0) - (lowKey[i]|0);
  
      if (diff > 1) {
        const newKey = new Uint8Array(i + 1);
        newKey.set(lowKey.slice(0, i + 1));
        newKey[i] = (lowKey[i]|0) + (diff >>> 1);
        return newKey;
      }
    }

    return lowKey.slice();
  }
  
  getSizedTypes(action, ...args) {
    const options = [];

    for (const type of this.BuiltIns.TYPES.filter(t => t.size > 0)) {
      options.push({text: type.text, style: "keyword", action, args: [type, ...args]});
    }

    return options;
  }
  
  getVisibleVars(row, requiresMutable, action, ...args) {
    const options = [];

    let indent = this.getIndent(row);

    for (let r = Math.min(this.lineCount, row) - 1; r >= 0; --r) {
      const lineIndent = this.getIndent(r);
      if (lineIndent + this.isStartingScope(r) <= indent) {
        indent = lineIndent;
        if (!requiresMutable || this.getItem(r, 0) === this.BuiltIns.VAR) {
          for (const item of this.lines[r].items.filter(item => item.constructor === VarDef)) {
            options.push({text: item.name, style: "vardef", action, args: [...args, item]});
          }
        }
      }
    }

    options.sort((a, b) => a.text.localeCompare(b.text));
    return options;
  }

  getVisibleFuncs(row, col, scope, expectedType = this.BuiltIns.ANY) {
    //grab only the ones belonging to the scope
    let funcs = this.BuiltIns.FUNCTIONS.filter(func => func.signature.scope === scope);

    //prioritize functions that return the right type or who's return type express every
    //value the lvalue type can (i.e. double -> int)
    if (expectedType !== this.BuiltIns.ANY) {
      const perfect = funcs.filter(func => {
        return func.signature.returnType === expectedType;
      });

      const lossLess = funcs.filter(func => {
        return func.signature.returnType.size >= expectedType.size
          && expectedType.casts
          && expectedType.casts.get(func.signature.returnType)
          && expectedType.casts.get(func.signature.returnType).preferred;
      });

      const lossy = funcs.filter(func => {
        return func.signature.returnType.size >= expectedType.size
          && expectedType.casts
          && expectedType.casts.get(func.signature.returnType);
      });

      const lossier = funcs.filter(func => {
        return expectedType.casts
        && expectedType.casts.get(func.signature.returnType)
      });

      funcs = [...perfect, ...lossLess, ...lossy, ...lossier];
    }
    
    //keep only the first function with a given name (rely on overloading)
    funcs = funcs.filter((v, i, a) => {
      return a.findIndex(func => func.signature.name === v.signature.name) === i;
    });

    const options = [];
    for (const func of funcs) {
      options.push({
        text: func.signature.name, style: "funcdef",
        action: this.insertFuncCall, args: [row, col, func]
      });
    }

    return options;
  }

  runTypeInference(row) {
    const itemCount = this.getItemCount(row);
    if (itemCount < 2) {
      return;
    }

    const item = this.getItem(row, 1);
    if (item.constructor !== VarDef) {
      return;
    }

    if (item.typeAnnotated === true) {
      return;
    }
    
    //TODO handle detecting non-primative types
    const promotions = [
      this.BuiltIns.U32, this.BuiltIns.I32, this.BuiltIns.U64,
      this.BuiltIns.I64, this.BuiltIns.F32, this.BuiltIns.F64, this.BuiltIns.STRING
    ];
    
    let status = -1;
    
    for (let col = 2; col < itemCount; ++col) {
      const item = this.getItem(row, col);

      if (item.isUnary && (col === itemCount - 1 || this.getItem(row, col + 1) === this.BuiltIns.PLACEHOLDER)) {
        status = Math.max(status, 1); //assume I32
      }

      if (item.getType) {
        status = Math.max(status, promotions.indexOf(item.getType()));
      }
    }

    let rvalueType = this.BuiltIns.VOID;
    if (status !== -1) {
      rvalueType = promotions[status];
    }

    //this makes the assumption that any expression with a bool op is a bool expression
    if (this.lines[row].items.some(item => item.isBool)) {
      rvalueType = this.BuiltIns.BOOL;
    }

    item.type = rvalueType;
    this.saveLines([this.lines[row]]);
  }

  get lineCount() {
    return this.lines.length;
  }

  getItemCount(row) {
    return row < this.lines.length ? this.lines[row].items.length : 0;
  }

  getItem(row, col) {
    return row < this.lines.length ? this.lines[row].items[col] : {};
  }

  setItem(row, col, val) {
    this.lines[row].items[col] = val;
    this.saveLines([this.lines[row]]);
  }

  spliceLine(row, col, count, ...items) {
    this.lines[row].items.splice(col, count, ...items);
    this.saveLines([this.lines[row]]);
  }

  pushItems(row, ...items) {
    this.lines[row].items.push(...items);
    this.saveLines([this.lines[row]]);
  }

  getIndent(row) {
    return row < this.lines.length ? this.lines[row].indent : 0;
  }

  isStartingScope(row) {
    return [
      this.BuiltIns.IF, this.BuiltIns.ELSE, this.BuiltIns.WHILE,
      this.BuiltIns.DO_WHILE, this.BuiltIns.FOR, this.BuiltIns.FUNC
    ].includes(this.lines[row].items[0]);
  }

  performTransactions(mode, actions) {
    const openRequest = indexedDB.open("TouchScript-" + this.projectID, 2);
  
    openRequest.onerror = (event) => alert("Open request error: " + event.errorCode);
    openRequest.onupgradeneeded = function(event) {
      console.log("upgrading database");
      const db = event.target.result;
      db.createObjectStore("lines", {keyPath: "key"});
      db.createObjectStore("save-data");
    };
    openRequest.onsuccess = function(event) {
      const db = event.target.result;
      db.onerror = (event) => alert("Database error: " + event.target.errorCode);

      const transaction = db.transaction("lines", mode);
      const linesStore = transaction.objectStore("lines");
      
      for (const action of actions) {
        action.func.apply(linesStore, action.args);
      }
      actions.length = 0;
    };
  }

  /**
   * Opens a transaction and performs the action on it.  If the project did not already exist, creates it.
   * @param {Function} func func that expects object store bound to this and additional arguments
   * @param {*[]} args remainder of arguments that are sent to the action function
   */
  queueTransation(func, ...args) {
    this.queuedTransations.push({func, args});

    if (this.queuedTransations.length === 1) {
      performActionOnProjectListDatabase("readwrite", (objStore, transaction) => {
        objStore.get(this.projectID).onsuccess = (event) => {
          if (event.target.result) {
            //console.log("Updating edit date of project " + this.projectID);
            const projectListing = event.target.result;
            projectListing.lastModified = new Date();
            objStore.put(projectListing);
            this.performTransactions("readwrite", this.queuedTransations);
          } else {
            objStore.getAllKeys().onsuccess = (event) => {
              let id = event.target.result.findIndex((el, i) => el !== i+1);
              if (id === -1) {
                id = event.target.result.length + 1
              }

              const now = new Date();
              const newProject = {id, name: "Project " + id, created: now, lastModified: now};
        
              objStore.put(newProject).onsuccess = (event) => {
                this.projectID = event.target.result;
                localStorage.setItem(ACTIVE_PROJECT_KEY, this.projectID);
                console.log("Successfully created new project.  ID is", this.projectID);

                this.queuedTransations.length = 0;
                this.saveLines(this.lines);
                this.performTransactions("readwrite", this.queuedTransations);
              }
            }
          }
        }
      });
    }
  }

  /*
  Generates a Wasm binary from the script contents
  */
  getWasm() {
    function getWasmType(type) {
      switch (type) {
        case script.BuiltIns.I32:
        case script.BuiltIns.U32:
        case script.BuiltIns.STRING:
        case script.BuiltIns.BOOL:
          return Wasm.types.i32;

        case script.BuiltIns.I64:
        case script.BuiltIns.U64:
          return Wasm.types.i64;

        case script.BuiltIns.F32:
          return Wasm.types.f32;

        case script.BuiltIns.F64:
          return Wasm.types.f64;

        default:
          console.log(type);
          console.trace();
          throw "cannot find Wasm type of " + type;
      }
    }

    class InternalNumericLiteral {
      constructor(rawString) {
        this.value = +rawString;
        this.isFloat = /[\.e]/i.test(rawString);
      }
      
      performUnaryOp(unaryOp) {
        switch (unaryOp) {
        case "!":
          this.value = ~this.value;
          break;
        case "-":
          this.value = -this.value;
          break;
        default:
          throw "unrecognized unary operator " + unaryOp;
        }
      }
      
      performBinaryOp(binOp, operand) {
        switch (binOp) {
          case "+":
            this.value += operand.value;
            break;
          case "-":
            this.value -= operand.value;
            break;
          case "*":
            this.value *= operand.value;
            break;
          case "/":
            this.value /= operand.value;
            break;
          case "%":
            this.value %= operand.value;
            break;
          case "|":
            this.value |= operand.value;
            break;
          case "^":
            this.value ^= operand.value;
            break;
          case "&":
            this.value &= operand.value;
            break;
          case "<<":
            this.value <<= operand.value;
            break;
          case ">>":
            this.value >>= operand.value;
            break;
          default:
            throw "unrecognized binary operator: " + binOp;
        }
        
        this.isFloat = this.isFloat || operand.hasDecimalPoint;
        if (!this.isFloat) {
          this.value = Math.trunc(this.value);
        }
      }
      
      getWasmCode(expectedType) {
        const outputType = this.getType(expectedType);
        switch (getWasmType(outputType)) {
          case Wasm.types.i32:
            return [Wasm.i32_const, ...Wasm.varint(this.value)];
          case Wasm.types.i64:
            return [Wasm.i64_const, ...Wasm.varint(this.value)];
          case Wasm.types.f32:
            return [Wasm.f32_const, ...Wasm.f32ToBytes(this.value)];
          case Wasm.types.f64:
            return [Wasm.f64_const, ...Wasm.f64ToBytes(this.value)];
        }
      }

      getType(expectedType = script.BuiltIns.ANY) {
        if ([script.BuiltIns.I32, script.BuiltIns.I64, script.BuiltIns.U32, script.BuiltIns.U64,
        script.BuiltIns.F32, script.BuiltIns.F64].includes(expectedType)) {
          return expectedType;
        }

        if (this.isFloat) {
          return script.BuiltIns.F32;
        } else {
          return script.BuiltIns.I32;
        }
      }
    }
    
    class InternalStringLiteral {
      constructor(address) {
        this.address = address;
      }
      
      getType() {
        return script.BuiltIns.STRING;
      }
      
      getWasmCode() {
        return [Wasm.i32_const, ...Wasm.varint(this.address)];
      }
    }
    
    class LocalVarReference {
      constructor(index, variable) {
        this.index = index;
        this.variable = variable;
      }
      
      getType() {
        return this.variable.type;
      }
      
      getWasmCode() {
        return [Wasm.get_local, ...Wasm.varuint(this.index)];
      }
    }
    
    class Placeholder {
      constructor(type, ...wasmCode) {
        this.type = type;
        this.wasmCode = wasmCode;
      }
      
      getType() {
        return this.type;
      }
      
      getWasmCode() {
        return this.wasmCode;
      }
    }
    
    function compileExpression(expression, expectedType) {
      const operators = [];
      const operands = [];

      expression.push(new Symbol("term", -1000, {isFoldable: false})); //terminate expression
      for (let i = 0; i < expression.length; ++i) {
        const item = expression[i];
        if (item.constructor === Symbol) {
          if (item.direction !== 1) {
            //check if the previous operators have a higher precedence than the one that is about to be pushed
            while (operators.length > 0 && operators[operators.length - 1].precedence >= item.precedence) {
              const operator = operators.pop();
              const rightOperand = operands.pop();
              if (operator.isUnary) {
                if (rightOperand.constructor === InternalNumericLiteral) {
                  rightOperand.performUnaryOp(operator.appearance);
                  operands.push(rightOperand);
                } else {
                  const {resultType, wasmCode} = operator.uses.get(rightOperand.getType());
                  operands.push(new Placeholder(resultType, ...rightOperand.getWasmCode(), ...wasmCode));
                }
              } else {
                const leftOperand = operands.pop();
                if (operator.isFoldable && leftOperand.constructor === InternalNumericLiteral
                && rightOperand.constructor === InternalNumericLiteral) {
                  leftOperand.performBinaryOp(operator.appearance, rightOperand);
                  operands.push(leftOperand);
                } else {
                  let type = rightOperand.getType(leftOperand.getType());
                  if (operator.isRange) {
                    type = expectedType;
                  }
                  const {resultType, wasmCode} = operator.uses.get(type);
                  operands.push(new Placeholder(resultType, ...leftOperand.getWasmCode(type), ...rightOperand.getWasmCode(type), ...wasmCode));
                }
              }
            }
          }

          if (item.direction === -1) {
            operators.pop();
          } else {
            operators.push(item);
          }
        } else {
          operands.push(item);
        }
      }
      
      //console.log("remaining operands", ...operands, "remaining operators", ...operators.slice(0, -1));
      const expressionType = operands[0].getType(expectedType);
      const wasmCode = operands[0].getWasmCode(expectedType);

      if (expressionType !== expectedType) {
        const cast = expectedType.casts && expectedType.casts.get(expressionType);
        if (cast) {
          wasmCode.push(...cast.wasmCode);
        } else {
          console.log("cast from", expressionType.text, "to", expectedType.text, "not found");
        }
      }
      
      return [expressionType, wasmCode];
    }

    //keep track of which functions are used in this program
    const importedFuncs = [];

    //scan ahead for imported functions because they are listed first
    for (const line of this.lines) {
      for (const item of line.items) {
        if (item.constructor === FuncRef && item.funcDef.constructor === ImportedFunc) {
          if (!importedFuncs.includes(item.funcDef)) {
            importedFuncs.push(item.funcDef);
          }
        }
      }
    }

    const wasmFuncs = [];

    let mainFunc = [];

    const callStack = [];
    const expression = [];
    const localVarMapping = []; //maps local var indexes to TouchScript vars
    let lvalueType, lvalueLocalIndex;
    const endOfLineInstructions = [];
    const endOfScopeData = [];

    function insertPrecondition(wasmCode) {
      //The wasmCode array has code that produces a start value and an end value on the
      //operand stack, then a comparison opcode, then an increment opcode (typed add or sub).
      //Backup the comparison opcode for the break condition and the increment opcode for
      //the end of the loop body, then the start and stop values.;
      const lvar = localVarMapping[lvalueLocalIndex];

      //create a new local var with the same type as the looping var to hold the end value
      const endValLocalIndex = localVarMapping.length;
      localVarMapping.push(new VarDef("inc", lvar.type, {id: -1}));

      const comparisonOpcode = wasmCode.pop();

      mainFunc.push(...wasmCode);
      endOfLineInstructions.push(Wasm.set_local, endValLocalIndex);
      endOfLineInstructions.push(Wasm.set_local, lvalueLocalIndex);

      endOfLineInstructions.push(Wasm.block, Wasm.types.void);
      endOfLineInstructions.push(Wasm.loop, Wasm.types.void);

      endOfLineInstructions.push(Wasm.get_local, lvalueLocalIndex);
      endOfLineInstructions.push(Wasm.get_local, endValLocalIndex);
      endOfLineInstructions.push(comparisonOpcode, Wasm.i32_eqz);
      endOfLineInstructions.push(Wasm.br_if, 1);
    }

    const initialData = [];
    initialData.push(...Wasm.stringToLenPrefixedUTF8("false"), 0, 0); //address 0
    initialData.push(...Wasm.stringToLenPrefixedUTF8("true"));        //address 8

    for (let row = 0, endRow = this.lineCount; row < endRow; ++row) {
      lvalueType = this.BuiltIns.VOID;
      lvalueLocalIndex = -1;
      
      if (row > 0) {
        let scopeDrop = this.getIndent(row - 1) - this.getIndent(row);
        if (this.getItem(row, 0) === this.BuiltIns.ELSE) {
          --scopeDrop;
        }
        for (let i = 0; i < scopeDrop; ++i) {
          const scopeData = endOfScopeData.pop();
          mainFunc.push(...scopeData.wasmCode);
          mainFunc.push(...Array(scopeData.blockCount).fill(Wasm.end));
        }
      }

      for (let col = 0, endCol = this.getItemCount(row); col < endCol; ++col) {
        const item = this.getItem(row, col);

        switch (item.constructor) {
          case VarDef: {
            expression.push(new LocalVarReference(localVarMapping.length, item));
            localVarMapping.push(item);
          } break;
          
          case VarRef: {
            const localIndex = localVarMapping.findIndex(localVar => localVar === item.varDef);
            if (localIndex === -1) {
              throw "var" + value + " is referenced before it is declared";
            }
            
            expression.push(new LocalVarReference(localIndex, localVarMapping[localIndex]));
          } break;
          
          case FuncRef:
            callStack.push(item.funcDef);
            break;

          case ArgHint: {
            const param = item.funcDef.signature.parameters[item.argIndex];
            if (param.default) {
              if (param.type === this.BuiltIns.STRING || param.type === this.BuiltIns.ANY) {
                expression.push(new InternalStringLiteral(initialData.length));
                initialData.push(...Wasm.stringToLenPrefixedUTF8(param.default));
              } else {
                expression.push(new InternalNumericLiteral(param.default));
              }
            }
          } break;

          case Symbol: {
            const func = callStack[callStack.length - 1];
            
            if (item.isAssignment) {
              const localVar = expression.pop();
              lvalueType = localVar.getType();
              lvalueLocalIndex = localVar.index;
              
              if (item !== this.BuiltIns.ASSIGN) {
                mainFunc.push(Wasm.get_local, ...Wasm.varint(localVar.index));
                const {wasmCode, resultType} = item.uses.get(lvalueType);
                endOfLineInstructions.push(...wasmCode);
              }
              
              endOfLineInstructions.push(Wasm.set_local, localVar.index);
            }

            let wasmCode = [];
            let expressionType;
            if ((item === this.BuiltIns.ARG_SEPARATOR || item === this.BuiltIns.END_ARGS)
            && func.signature.parameters.length > 0) {
              //find argument type
              let expectedType = this.BuiltIns.ANY;
              let funcCallDepth = 0;
              let argumentIndex = 0;
              for (let j = col - 1; j > 0; --j) {
                const item = this.getItem(row, j);
                if (item === this.BuiltIns.END_ARGS) {
                  ++funcCallDepth;
                }
                if (item === this.BuiltIns.ARG_SEPARATOR && funcCallDepth === 0) {
                  ++argumentIndex;
                }
                if (item === this.BuiltIns.BEGIN_ARGS) {
                  if (funcCallDepth === 0) {
                    const func = this.getItem(row, j - 1).funcDef;
                    if (func === this.BuiltIns.PRINT) {
                      argumentIndex = 0;
                    }
                    const argumentType = func.signature.parameters[argumentIndex].type;
                    //console.log(expression, "is argument ", argumentIndex, "to ", func.signature.name, "argument type is", argumentType.text);
                    expectedType = argumentType;
                    break;
                  }
                  
                  --funcCallDepth;
                }
              }

              [expressionType, wasmCode] = compileExpression(expression, expectedType);
              expression.length = 0;
            }

            mainFunc.push(...wasmCode);

            //print() builds a string in memory from each argument before printing it
            if (func === this.BuiltIns.PRINT || func === this.BuiltIns.PRINTLN) {
              if (item === this.BuiltIns.BEGIN_ARGS) {
                //push the current stack pointer onto the operand stack for later retrival
                mainFunc.push(
                  Wasm.get_global, 0,
                );
              } else if (item === this.BuiltIns.ARG_SEPARATOR) {
                //append a space to the stack string
                mainFunc.push(
                  Wasm.get_global, 0, //*SP = ' '
                  Wasm.i32_const, ' '.charCodeAt(),
                  Wasm.i32_store8, 0, 0,
                  Wasm.get_global, 0, // ++SP
                  Wasm.i32_const, 1,
                  Wasm.i32_add,
                  Wasm.set_global, 0,
                );
              } else if (item === this.BuiltIns.END_ARGS && func === this.BuiltIns.PRINTLN) {
                //append a newline to the stack string
                mainFunc.push(
                  Wasm.get_global, 0, //*SP = '\n'
                  Wasm.i32_const, '\n'.charCodeAt(),
                  Wasm.i32_store8, 0, 0,
                  Wasm.get_global, 0, // ++SP
                  Wasm.i32_const, 1,
                  Wasm.i32_add,
                  Wasm.set_global, 0,
                );
              }
              
              if (item === this.BuiltIns.END_ARGS || item === this.BuiltIns.ARG_SEPARATOR) {
                //build the string of the argument in-place on the stack

                //if the argument is a primative, use specialized printing functions
                if (expressionType === this.BuiltIns.I32) {
                  wasmCode.push(Wasm.i64_extend_s_from_i32);
                  expressionType = this.BuiltIns.I64;
                }
                if (expressionType === this.BuiltIns.U32) {
                  wasmCode.push(Wasm.i64_extend_u_from_i32);
                  expressionType = this.BuiltIns.U64;
                }
                if (expressionType === this.BuiltIns.F32) {
                  wasmCode.push(Wasm.f64_promote_from_f32);
                  expressionType = this.BuiltIns.F64;
                }

                const func = script.BuiltIns.FUNCTIONS.find(func => {
                  return func.signature.scope === expressionType
                          && func.signature.name === "toString"
                });
      
                if (func) {
                  if (func.constructor === PredefinedFunc) {
                    let funcIndex = wasmFuncs.indexOf(func);
                    if (funcIndex === -1) {
                      funcIndex = wasmFuncs.length;
                      wasmFuncs.push(func);
                    }
                    wasmCode.push(Wasm.call, funcIndex + importedFuncs.length + 1);
                  } else {
                    wasmCode.push(...func.wasmCode);
                  }
                } else {
                  console.log("failed to find toString() implementation for", expressionType);
                  throw "failed to find toString() implementation for " + expressionType.text;
                }
              }
            }

            if (item === this.BuiltIns.END_ARGS) {
              if (func.constructor === Macro) {
                mainFunc.push(...func.wasmCode);
              }
              if (func.constructor === PredefinedFunc) {
                let index = wasmFuncs.indexOf(func);
                if (index === -1) {
                  index = wasmFuncs.length;
                  wasmFuncs.push(func);
                }
                mainFunc.push(Wasm.call, index + importedFuncs.length + 1);
              }
              if (func.constructor === ImportedFunc) {
                const index = importedFuncs.indexOf(func);
                mainFunc.push(Wasm.call, index);
              }
              if (func.signature.returnType !== this.BuiltIns.VOID) {
                expression.push(new Placeholder(func.signature.returnType)); //TODO place wasm code of function call as 2nd argument
              }
            } 

            if (item === this.BuiltIns.END_ARGS) {
              callStack.pop()
            }
            
            if (![this.BuiltIns.ARG_SEPARATOR, this.BuiltIns.BEGIN_ARGS, this.BuiltIns.END_ARGS].includes(item) && !item.isAssignment) {
              expression.push(item);
            }
          } break;
          
          case Keyword: {
            switch (item) {
              case this.BuiltIns.IF: {
                lvalueType = this.BuiltIns.BOOL;
                endOfLineInstructions.push(Wasm.if, Wasm.types.void);
                endOfScopeData.push({wasmCode: []});
              } break;
              case this.BuiltIns.ELSE: {
                endOfLineInstructions.push(Wasm.else);
              } break;
              case this.BuiltIns.WHILE: {
                lvalueType = this.BuiltIns.BOOL;
                mainFunc.push(Wasm.block, Wasm.types.void, Wasm.loop, Wasm.types.void);
                endOfLineInstructions.push(Wasm.i32_eqz, Wasm.br_if, 1);
                endOfScopeData.push({wasmCode: [Wasm.br, 0], isBranchable: true, blockCount: 2});
              } break;
              case this.BuiltIns.DO_WHILE: {
                lvalueType = this.BuiltIns.BOOL;
                mainFunc.push(Wasm.block, Wasm.types.void, Wasm.loop, Wasm.types.void);
                endOfScopeData.push({wasmCode: [Wasm.br_if, 0], isBranchable: true, blockCount: 2});
              } break;
              case this.BuiltIns.BREAK: {
                let requestedDepth = 1;

                if (this.getItemCount(row) >= 2) {
                  const {value} = this.getData(row, col + 1);
                  requestedDepth = +this.literals.get(value);
                }

                //branch depth must be 1 over the depth of the loop to break out rather than repeat
                let depthTraveled = 1;
                for (let i = endOfScopeData.length - 1; i >= 0; --i) {
                  if (endOfScopeData[i].isBranchable && --requestedDepth <= 0) {
                    mainFunc.push(Wasm.br, depthTraveled);
                    break;
                  }

                  ++depthTraveled;
                  if (endOfScopeData[i].isBranchable) {
                    ++depthTraveled;
                  }
                }
                col = 1000; //do not attempt to write any expression using the rest of this line
              } break;
              case this.BuiltIns.CONTINUE: {
                let requestedDepth = 1;

                if (this.getItemCount(row) >= 2) {
                  requestedDepth = this.getItem(row, 1).loopLayers;
                }

                let depthTraveled = 0;
                //work backward through the scopes until we find one that is branchable
                for (let i = endOfScopeData.length - 1; i >= 0; --i) {
                  const scopeData = endOfScopeData[i];
                  if (scopeData.isBranchable && --requestedDepth <= 0) {
                    //slice off the depth of the branch instruction and use our own
                    mainFunc.push(...scopeData.wasmCode.slice(0, -1), depthTraveled);
                    break;
                  }

                  ++depthTraveled;
                  if (scopeData.isBranchable) {
                    ++depthTraveled;
                  }
                }
                col = 1000; //do not attempt to write any expression using the rest of this line
              } break;
              case this.BuiltIns.IN: {
                const localVar = expression.pop(); //consume the looping variable reference
                lvalueType = localVar.getType();
                lvalueLocalIndex = localVar.index;
              } break;
              case this.BuiltIns.STEP: { //part of a for loop
                const [, wasmCode] = compileExpression(expression, lvalueType);
                expression.length = 0;
                const incrementOpcode = wasmCode.pop();

                const lvar = localVarMapping[lvalueLocalIndex];
                const stepSizeLocalIndex = localVarMapping.length;
                localVarMapping.push(new VarDef("inc", lvar.type, {id: -1}));

                endOfLineInstructions.push(Wasm.set_local, stepSizeLocalIndex);

                endOfScopeData.push({wasmCode: [
                  Wasm.get_local, lvalueLocalIndex,
                  Wasm.get_local, stepSizeLocalIndex,
                  incrementOpcode,
                  Wasm.set_local, lvalueLocalIndex,
                  Wasm.br, 0,
                ], isBranchable: true, blockCount: 2});

                insertPrecondition(wasmCode);
              } break;
            }
          } break;

          case BooleanLiteral:
            expression.push(new Placeholder(this.BuiltIns.BOOL, Wasm.i32_const, item.value|0));
          break;
          
          case StringLiteral:
            expression.push(new InternalStringLiteral(initialData.length));

            const stringLiteral = item.text.replace(/\\n/g, "\n");
            initialData.push(...Wasm.stringToLenPrefixedUTF8(stringLiteral));
          break;

          case NumericLiteral:
            expression.push(new InternalNumericLiteral(item.text));
          break;
        }
      }

      //end of line delimits expression
      if (expression.length > 0) {
        const [, wasmCode] = compileExpression(expression, lvalueType);
        expression.length = 0;

        if (this.getItem(row, 0) === this.BuiltIns.DO_WHILE) {
          //move the expression to right before the conditional loop branch
          endOfScopeData[endOfScopeData.length - 1].wasmCode.unshift(...wasmCode);
        } else if (this.getItem(row, 0) === this.BuiltIns.FOR) {
          if (!this.lines[row].items.includes(this.BuiltIns.STEP)) {
            const incrementOpcode = wasmCode.pop();
            insertPrecondition(wasmCode)

            //if the step size is not specified, use the numeric literal "1"
            const constStep = (new InternalNumericLiteral("1")).getWasmCode(lvalueType);

            endOfScopeData.push({wasmCode: [
              Wasm.get_local, lvalueLocalIndex,
              ...constStep,
              incrementOpcode,
              Wasm.set_local, lvalueLocalIndex,
              Wasm.br, 0,
            ], isBranchable: true, blockCount: 2});
          } else {
            mainFunc.push(...wasmCode);
          }
        } else {
          mainFunc.push(...wasmCode);
          if (endOfLineInstructions.length === 0) {
            mainFunc.push(Wasm.drop);
          }
        }
      }
      
      if (endOfLineInstructions.length > 0) {
        mainFunc.push(...endOfLineInstructions);
        endOfLineInstructions.length = 0;
      }
    }
    
    while (endOfScopeData.length > 0) {
      const scopeData = endOfScopeData.pop();
      mainFunc.push(...scopeData.wasmCode);
      mainFunc.push(...Array(scopeData.blockCount).fill(Wasm.end));
    }

    const localVarDefinition = [];

    //collapses paramaters of the same type that are next to each other
    let localEntriesCount = 0;
    for (let i = 0; i < localVarMapping.length;) {
      const local = localVarMapping[i];
      const type = getWasmType(local.type);
      let count = 0;
      while (i < localVarMapping.length && getWasmType(localVarMapping[i].type) === type) {
        ++count;
        ++i;
      }
      localVarDefinition.push(count, type);
      ++localEntriesCount;
    }

    localVarDefinition.unshift(
      ...Wasm.varuint(localEntriesCount), //count of local entries (count and type pairs, not total locals)
    )

    mainFunc = [...localVarDefinition, ...mainFunc, Wasm.end];

    //figure out which function signatures we need to define
    const signatures = [{
      returnType: this.BuiltIns.VOID,
      parameterTypes: [],
    }];

    for (const func of [...importedFuncs, ...wasmFuncs]) {
      const signature = {
        returnType: func.signature.returnType,
        parameterTypes: func.signature.parameters.map(p => p.type),
      };

      if (!signatures.find(sig => {
        if (signature.returnType !== sig.returnType) {
          return false;
        }

        if (signature.parameterTypes.length !== sig.parameterTypes.length) {
          return false;
        }

        for (let i = 0; i < signature.parameterTypes.length; ++i) {
          if (signature.parameterTypes[i] !== sig.parameterTypes[i]) {
            return false;
          }
        }

        return true;
      })) {
        signatures.push(signature);
      }
    }

    const getSignature = (func) => {
      return signatures.findIndex(sig => {
        if (func.signature.returnType !== sig.returnType) {
          return false;
        }

        if (func.signature.parameters.length !== sig.parameterTypes.length) {
          return false;
        }

        for (let i = 0; i < func.signature.parameters.length; ++i) {
          if (func.signature.parameters[i].type !== sig.parameterTypes[i]) {
            return false;
          }
        }

        return true;
      })
    }


    const typeSection = [
      ...Wasm.varuint(signatures.length), //count of type entries
    ];
    for (const signature of signatures) {
      const wasmReturnTypes = [];
      if (signature.returnType !== this.BuiltIns.VOID) {
        wasmReturnTypes.push(getWasmType(signature.returnType));
      }
      
      const wasmParamaterTypes = signature.parameterTypes.map(type => getWasmType(type));

      typeSection.push(Wasm.types.func);
      typeSection.push(wasmParamaterTypes.length, ...wasmParamaterTypes);
      typeSection.push(wasmReturnTypes.length, ...wasmReturnTypes);
    }
   
    let importSection = [
      ...Wasm.varuint(importedFuncs.length + 1), //count of things to import

      ...Wasm.stringToLenPrefixedUTF8("js"),
      ...Wasm.stringToLenPrefixedUTF8("memory"),
      Wasm.externalKind.Memory,
      0, //flag that max pages is not specified
      ...Wasm.varuint(1), //initially 1 page allocated
    ]

    for (const func of importedFuncs) {
      importSection.push(
        ...Wasm.stringToLenPrefixedUTF8(func.moduleName),
        ...Wasm.stringToLenPrefixedUTF8(func.fieldName),
        Wasm.externalKind.Function,
        ...Wasm.varuint(getSignature(func)),
      );
    }

    let functionSection = [
      ...Wasm.varuint(wasmFuncs.length + 1), //count of function bodies defined later
      ...Wasm.varuint(0), //type indicies (func signitures)
    ];

    for (const func of wasmFuncs) {
      functionSection.push(getSignature(func)); 
    }

    // let exportSection = [
    //   ...Wasm.varuint(0), //count of exports

    //   ...Wasm.getStringBytesAndData("init"), //length and bytes of function name
    //   Wasm.externalKind.Function, //export type
    //   ...Wasm.varuint(importedFunctionsCount), //exporting entry point function
    // ];

    let codeSection = [
      ...Wasm.varuint(wasmFuncs.length + 1), //count of functions to define
      ...Wasm.varuint(mainFunc.length),
      ...mainFunc,
    ];

    for (const func of wasmFuncs) {
      codeSection.push(
        ...Wasm.varuint(func.wasmCode.length),
        ...func.wasmCode
      );
    }

    let dataSection = [
      ...Wasm.varuint(1), //1 data segment

      0, //memory index 0
      Wasm.i32_const, Wasm.varint(0), Wasm.end, //fill memory starting at address 0
      ...Wasm.varuint(initialData.length), //count of bytes to fill in
      ...initialData,
    ];

    const globalSection = [
      ...Wasm.varuint(1),
      Wasm.types.i32, 1,
      Wasm.i32_const, ...Wasm.varuint(initialData.length),
      Wasm.end,
    ];

    let wasm = [
      0x00, 0x61, 0x73, 0x6d, //magic numbers
      0x01, 0x00, 0x00, 0x00, //binary version
  
      Wasm.section.Type,
      ...Wasm.varuint(typeSection.length), //size in bytes of section
      ...typeSection,
  
      Wasm.section.Import,
      ...Wasm.varuint(importSection.length),
      ...importSection,
  
      Wasm.section.Function,
      ...Wasm.varuint(functionSection.length),
      ...functionSection,

      Wasm.section.Global,
      ...Wasm.varuint(globalSection.length),
      ...globalSection,
  
      // Wasm.section.Export,
      // ...Wasm.varuint(exportSection.length),
      // ...exportSection,

      Wasm.section.Start,
      [...Wasm.varuint(importedFuncs.length)].length,
      ...Wasm.varuint(importedFuncs.length), //the start function is the first function after the imports
  
      Wasm.section.Code,
      ...Wasm.varuint(codeSection.length),
      ...codeSection,

      Wasm.section.Data,
      ...Wasm.varuint(dataSection.length),
      ...dataSection,
    ];

    return (new Uint8Array(wasm)).buffer;
  }
}