/******************************************************************************
 *    Copyright 2018 The LuaCoderAssist Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 ********************************************************************************/
'use strict';

const { Scope } = require('./linear-stack');
const {
    LuaSymbolKind,
    LuaSymbol,
    LuaFunction,
    LuaTable,
    LuaModule,
    LuaContext,
    lazyType,
    Range,
    LuaBasicTypes
} = require('./symbol');
const is = require('./is');
const utils_1 = require('./utils');
const luaenv_1 = require('./luaenv');
const { typeOf } = require('./typeof');
const luaparse_1 = require('luaparse');

// _G
let _G = luaenv_1._G;

/**
 * Analysis the document
 * @param {String} code Code content of the document
 * @param {String} uri The uri of the document
 */
function analysis(code, uri) {
    let moduleType = new LuaModule(uri);
    moduleType.setmetatable(luaenv_1.global__metatable);

    let matchs = uri.match(/(\w+(-\w+)*)(\.lua)?$/);
    let rootScope = Range.new(0, code.length + 1);
    let rootStack = moduleType.menv.stack;
    let currentScope = new Scope(rootStack, rootScope);
    let theModule = new LuaSymbol(matchs[1], Range.new(0, 1), rootScope, rootScope, false, uri, LuaSymbolKind.module, moduleType);
    theModule.state = { valid: true };
    theModule.children = [];

    let funcStack = [];
    let currentFunc = null;

    function isPlaceHolder(name) {
        return name === '_';
    }

    function parseInitStatement(init, index, name, location, range, isLocal, done) {
        if (!init) {
            let type = LuaBasicTypes.any;
            let scope = Range.rangeOf(location, currentScope.range);
            let symbol = new LuaSymbol(name, location, range, scope, isLocal, uri, LuaSymbolKind.variable, type);
            symbol.state = theModule.state;
            done && done(symbol);
            walkNode(init);
            return;
        }

        if (init.type === 'TableConstructorExpression') {
            let type = parseTableConstructorExpression(init, name);
            let kind = LuaSymbolKind.table;
            let scope = Range.rangeOf(location, currentScope.range);
            let table = new LuaSymbol(name, location, init.range, scope, isLocal, uri, kind, type);
            table.state = theModule.state;
            done(table);
            return;
        }
        
        if (init.type === 'FunctionDeclaration') {
            parseFunctionDeclaration(init, name, location, isLocal, done);
            return;
        }

        let scope = Range.rangeOf(location, currentScope.range);

        if (init.type === 'CallExpression') {
            let fname = init.base.name;
            let symbol, type;
            if (fname == 'setmetatable') {
                symbol = parseSetmetatable(init, name, location, scope, isLocal);
                if (!symbol) {
                    let refName = init.arguments[0].name || utils_1.safeName(init);
                    type = lazyType(new LuaContext(moduleType), init, refName, index);
                }
            } else {
                type = lazyType(new LuaContext(moduleType), init, utils_1.safeName(init), index);
            }

            if (!symbol) {
                symbol = new LuaSymbol(name, location, range, scope, isLocal, uri, LuaSymbolKind.variable, type);
            }

            symbol.state = theModule.state;
            done(symbol);
            walkNode(init);
            return;
        }

        { //else
            let type;
            if (init.name === name) {
                // local string = string
                if (init.isLocal) {
                    let def = currentScope.stack.search((sym) => sym.name == name);
                    type = def ? def.type : undefined;
                } else {
                    type = typeOf(_G.get(name));
                }
            } else {
                type = lazyType(new LuaContext(moduleType), init, utils_1.safeName(init), index);
            }

            let symbol = new LuaSymbol(name, location, range, scope, isLocal, uri, LuaSymbolKind.variable, type);
            symbol && (symbol.state = theModule.state);
            done(symbol);
            walkNode(init);
            return;
        }
    }

    function parseDependence(node, param) {
        if (!param || param.type !== 'StringLiteral') {
            return;
        }

        let matches = param.value.match(/\w+(-\w+)*$/);
        if (!matches) return;

        let name = matches[0];
        let symbol = lazyType(new LuaContext(moduleType), node, name, 0);
        moduleType.import(symbol);
    }

    // OK
    function parseLocalStatement(node) {
        let prevInit = node.init[0];
        let prevInitIndex = 0;
        node.variables.forEach((variable, index) => {
            let name = variable.name;
            if (isPlaceHolder(name)) {
                return;
            }

            let init = node.init[index];
            prevInit = init || prevInit;
            if (init) {
                prevInitIndex = index;
            }
            let idx = index - prevInitIndex; // in case: local x, y, z = true, abc()
            parseInitStatement(prevInit, idx, name, variable.range, variable.range, true, symbol => {
                if (!symbol) {
                    return;
                }
                currentScope.push(symbol);
                (currentFunc || theModule).addChild(symbol);
            });
        });
    }

    function ensureTable(symbol, kind) {
        if (!is.luaTable(typeOf(symbol))) {
            symbol.type = new LuaTable();
        }
        symbol.kind = kind;
    }

    // OK
    function parseAssignmentStatement(node) {
        let prevInit = node.init[0];
        let prevInitIndex = 0;
        node.variables.forEach((variable, index) => {
            let init = node.init[index];
            let name = utils_1.identName(variable);
            if (!name) {
                walkNode(init);
                return;
            }

            if (isPlaceHolder(name)) {
                return;
            }

            // in case: x, y, z = true, abc()
            prevInit = init || prevInit;
            if (init) {
                prevInitIndex = index;
            }

            // search parent
            function predict(S) {
                return (S.name === name) && (!S.isLocal || S.location[1] <= variable.range[0]);
            }

            let base, def;
            let bName = utils_1.baseNames(variable.base);
            if (bName.length > 0) {
                base = utils_1.directParent(rootStack, bName);
                if (!base || !is.luaTable(typeOf(base))) {
                    return;
                }
            } else {
                def = rootStack.search(predict);
                if (def && !is.luaAny(typeOf(def))) {
                    return;
                }
            }

            let idx = index - prevInitIndex;
            parseInitStatement(init, idx, name, variable.range, variable.range, variable.isLocal, (symbol) => {
                if (base) { // base.abc = xyz
                    ensureTable(base, LuaSymbolKind.table);
                    base.set(name, symbol, true);
                    return;
                }

                if (def) { // local xzy; xzy = 1
                    def.type = symbol.type;
                    return;
                }

                // abc = xyz
                (currentFunc || theModule).addChild(symbol);
                if (moduleType.moduleMode) {
                    currentScope.push(symbol);
                    moduleType.set(name, symbol);
                } else {
                    _G.set(name, symbol);
                    moduleType.menv.globals.set(name, symbol);
                }
            });
        });
    }

    // OK
    function parseTableConstructorExpression(node) {
        let table = new LuaTable();
        node.fields.forEach((field) => {
            if (!((field.type === 'TableKeyString') ||
                  (field.type === 'TableKey' && field.key.type === 'StringLiteral'))) {
                return;
            }
            let name = field.key.name || field.key.value;
            parseInitStatement(field.value, 0, name, field.key.range, field.value.range, false, symbol => {
                table.set(name, symbol);
            });
        });

        return table;
    }

    // OK
    function parseFunctionDeclaration(node, lvName, lvLocation, lvIsLocal, done) {
        let location, name, isLocal;
        let scope = lvIsLocal ? node.range : rootScope;
        let range = node.range;
        if (node.identifier) {
            location = node.identifier.range;
            name = utils_1.identName(node.identifier);
            isLocal = node.identifier.isLocal;
        } else {
            location = node.range;
            name = lvName || utils_1.safeName(node); // 匿名函数
            isLocal = lvIsLocal || false;
            scope[0] = (lvLocation || location)[0]; // enlarge to include the location
        }

        let ftype = new LuaFunction();
        let fsymbol = new LuaSymbol(name, location, range, scope, isLocal, uri, LuaSymbolKind.function, ftype);
        fsymbol.state = theModule.state;
        fsymbol.children = [];
        let _self, paramOffset = 0;

        if (fsymbol.isLocal) {
            /**
             * case: `local function foo() end`
             * case: `local foo; function foo() end`
             * case: `local foo; foo = function() end`
            */
           const predict = (S) => S.name === name;
           let prevDeclare = rootStack.search(predict)
           if (prevDeclare) {
               // 跳到变量定义处
               prevDeclare.location = fsymbol.location;
               prevDeclare.range = fsymbol.range;
               prevDeclare.scope = fsymbol.scope;
               prevDeclare.children = fsymbol.children;
               prevDeclare.type = ftype;
               prevDeclare.kind = LuaSymbolKind.function;
           } else {
               (currentFunc || theModule).addChild(fsymbol);
               currentScope.push(fsymbol);
           }
        } else if (done) {
            done(fsymbol);
        } else {

            /**
             * case 1: `function foo() end`  
             * case 2: `function class.foo() end` or `function class:foo() end`  
             * case 3: `function module.class:foo() end`  
             * ...
             */
            let baseNames = utils_1.baseNames(node.identifier && node.identifier.base);
            if (baseNames.length > 0) {
                let parent = utils_1.directParent(rootStack, baseNames);
                if (parent) {
                    ensureTable(parent, LuaSymbolKind.class);
                    parent.set(name, fsymbol);
                    if (node.identifier.indexer === ':') {
                        _self = new LuaSymbol('self', parent.location, parent.range, scope, true, parent.uri, parent.kind, parent.type);
                        _self.state = theModule.state;
                        ftype.param(0, _self);
                        paramOffset = 1;
                    }
                }
            } else {
                (currentFunc || theModule).addChild(fsymbol);
                if (moduleType.moduleMode) {
                    moduleType.set(name, fsymbol);
                } else {
                    _G.set(name, fsymbol);
                    moduleType.menv.globals.set(name, fsymbol);
                }

            }
        }

        currentScope = (new Scope(rootStack, scope)).enter(currentScope);

        node.parameters.forEach((param, index) => {
            let name = param.name || param.value;
            let symbol = new LuaSymbol(name, param.range, param.range, currentScope.range, true, uri, LuaSymbolKind.parameter, LuaBasicTypes.any);
            symbol.state = theModule.state;
            fsymbol.addChild(symbol);
            currentScope.push(symbol);
            ftype.param(index + paramOffset, symbol);
        });

        /* self is defined after the params */
        _self && currentScope.push(_self);

        funcStack.push(currentFunc);
        currentFunc = fsymbol;
        walkNodes(node.body);
        currentFunc = funcStack.pop();

        currentScope = currentScope.exit([node.range[1], node.range[1]]);
    }

    function parseCallExpression(node) {
        let fname = utils_1.identName(node.base);
        switch (fname) {
            case 'module':
                let mname = (node.argument || node.arguments[0]).value;
                theModule.name = mname;
                moduleType.moduleMode = true;
                return;
            case 'require':
                let param = (node.argument || node.arguments[0]);
                parseDependence(node, param);
                return;
            case 'pcall':
                if (node.arguments[0].value === 'require') {
                    parseDependence(node, node.arguments[1]);
                } else {
                    walkNodes(node.arguments);
                }
                return;
            case 'setmetatable':
                parseSetmetatable(node);
                return;
            default:
                walkNode(node.base);
                node.arguments && walkNodes(node.arguments);
                node.argument && walkNode(node.argument);
                break;
        }
    }

    function parseSetmetatable(node, name, location, scope, isLocal) {
        const tableNode = node.arguments[0];
        if (tableNode === undefined) {
            return;
        }

        let tableSymbol;
        if (tableNode.type === 'Identifier') {
            let baseTable = moduleType.search(tableNode.name, tableNode.range).value;
            // setmetatable returns a table with new name.
            if (baseTable && !is.luaTable(typeOf(baseTable))) {
                baseTable.type = new LuaTable();
                baseTable.kind = LuaSymbolKind.table;
            }
            if (name !== tableNode.name) {
                tableSymbol = new LuaSymbol(name, location, tableNode.range, scope, isLocal, uri,
                    LuaSymbolKind.table, baseTable && baseTable.type || LuaBasicTypes.any);
                tableSymbol.state = theModule.state;
            } else {
                tableSymbol = baseTable;
            }
        } else {
            if (tableNode.type === 'TableConstructorExpression') {
                let nodeType = parseTableConstructorExpression(tableNode);
                tableSymbol = new LuaSymbol(name, location, tableNode.range, scope, true, uri, LuaSymbolKind.table, nodeType);
                tableSymbol.state = theModule.state;
            }
        }
        if (tableSymbol && is.luaTable(typeOf(tableSymbol))) {
            let nodeType;
            let metaNode = node.arguments[1];
            if (metaNode.type === 'TableConstructorExpression') {
                nodeType = parseTableConstructorExpression(metaNode);
            } else {
                nodeType = lazyType(new LuaContext(moduleType), node.arguments[1], '__metatable');
            }

            let metatable = new LuaSymbol('__metatable', null, null, null, true, uri, LuaSymbolKind.table, nodeType);
            metatable.state = theModule.state;
            tableSymbol.type.setmetatable(metatable);
        }
        return tableSymbol;
    }

    function parseScopeStatement(node) {
        currentScope = (new Scope(rootStack, node.range)).enter(currentScope);
        walkNodes(node.body);
        currentScope = currentScope.exit([node.range[1], node.range[1]]);
    }

    function parseIfStatement(node) {
        walkNodes(node.clauses);
    }

    function parseReturnStatement(node) {
        let tailArgIdx = node.arguments.length - 1;
        node.arguments.forEach((arg, index) => {
            parseInitStatement(arg, 0, 'R' + index, arg.range, arg.range, arg.isLocal, (symbol) => {
                if ((tailArgIdx === index) && (arg.type === "CallExpression") && currentFunc) {
                    currentFunc.type.tailCall = symbol.type; //LazyValue
                }
                if (currentFunc) {
                    // return from function
                    currentFunc.type.return(index, symbol);
                } else {
                    // return from module
                    moduleType.return = symbol;
                }
            });
        });
    }

    function parseForNumericStatement(node) {
        currentScope = (new Scope(rootStack, node.range)).enter(currentScope);

        let variable = node.variable;
        let name = variable.name;
        if (!isPlaceHolder(name)) {
            let symbol = new LuaSymbol(name, variable.range, variable.range, currentScope.range, true, uri, LuaSymbolKind.variable, LuaBasicTypes.number);
            symbol.state = theModule.state;
            (currentFunc || theModule).addChild(symbol);
            currentScope.push(symbol);
        }

        walkNodes(node.body);
        currentScope = currentScope.exit([node.range[1], node.range[1]]);
    }

    function parseForGenericStatement(node) {
        currentScope = (new Scope(rootStack, node.range)).enter(currentScope);

        let variables = node.variables;
        variables.forEach((variable, index) => {
            let name = variable.name;
            if (!isPlaceHolder(name)) {
                let type = lazyType(new LuaContext(moduleType), node.iterators[0], name, index);
                let symbol = new LuaSymbol(name, variable.range, variable.range, currentScope.range, true, uri, LuaSymbolKind.variable, type);
                symbol.state = theModule.state;
                (currentFunc || theModule).addChild(symbol);
                currentScope.push(symbol);
            }
        });

        walkNodes(node.body);
        currentScope = currentScope.exit([node.range[1], node.range[1]]);
    }

    function walkNodes(nodes) {
        nodes.forEach(walkNode);
    }

    function walkNode(node) {
        if (!node) return;
        switch (node.type) {
            case 'AssignmentStatement':
                parseAssignmentStatement(node);
                break;
            case 'LocalStatement':
                parseLocalStatement(node);
                break;
            case 'FunctionDeclaration':
                parseFunctionDeclaration(node);
                break;
            case 'CallStatement':
                walkNode(node.expression);
                break;
            case 'CallExpression':  //in module mode(Lua_5.1)
            case 'StringCallExpression':
                parseCallExpression(node);
                break;
            case 'IfClause':
            case 'ElseifClause':
            case 'ElseClause':
            case 'WhileStatement':
            case 'RepeatStatement':
            case 'DoStatement':
                parseScopeStatement(node);
                break;
            case 'ForNumericStatement':
                parseForNumericStatement(node);
                break;
            case 'ForGenericStatement':
                parseForGenericStatement(node);
                break;
            case 'ReturnStatement':
                parseReturnStatement(node);
                break;
            case 'IfStatement':
                parseIfStatement(node);
                break;
            case 'MemberExpression':
                walkNode(node.base);
                break;
            case 'Chunk':
                walkNodes(node.body);
                break;
            default:
                break;
        }
    };

    const node = luaparse_1.parse(code, {
        comments: false,
        scope: true,
        ranges: true,
    });

    walkNode(node);

    if (moduleType.moduleMode) {
        let origModule = _G.get(theModule.name);
        if (!origModule) {
            _G.set(theModule.name, theModule);
        } else {
            mergeTableFields(origModule.type.fields, theModule.type.fields);
        }
    }

    return theModule;
}

function mergeTableFields(origTableFields, newTableFields) {
    for (const fid in newTableFields) {
        const newValue = newTableFields[fid];
        const origValue = origTableFields[fid];
        if (!origValue || !origValue.valid) {
            origTableFields[fid] = newValue;
        }
    }
}

exports.analysis = analysis;
