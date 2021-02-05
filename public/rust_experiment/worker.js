/******/ (function(modules) { // webpackBootstrap
/******/ 	self["webpackChunk"] = function webpackChunkCallback(chunkIds, moreModules) {
/******/ 		for(var moduleId in moreModules) {
/******/ 			modules[moduleId] = moreModules[moduleId];
/******/ 		}
/******/ 		while(chunkIds.length)
/******/ 			installedChunks[chunkIds.pop()] = 1;
/******/ 	};
/******/
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// object to store loaded chunks
/******/ 	// "1" means "already loaded"
/******/ 	var installedChunks = {
/******/ 		"main": 1
/******/ 	};
/******/
/******/ 	// object to store loaded and loading wasm modules
/******/ 	var installedWasmModules = {};
/******/
/******/ 	function promiseResolve() { return Promise.resolve(); }
/******/
/******/ 	var wasmImportObjects = {
/******/ 		"../pkg/shp_contour_wasm_bg.wasm": function() {
/******/ 			return {
/******/ 				"./shp_contour_wasm_bg.js": {
/******/ 					"__wbg_marshallgeometry_new": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_marshallgeometry_new"](p0i32);
/******/ 					},
/******/ 					"__wbg_Window_7c62015b0ef67fce": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_Window_7c62015b0ef67fce"](p0i32);
/******/ 					},
/******/ 					"__wbindgen_is_undefined": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_is_undefined"](p0i32);
/******/ 					},
/******/ 					"__wbindgen_object_drop_ref": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_object_drop_ref"](p0i32);
/******/ 					},
/******/ 					"__wbg_WorkerGlobalScope_2f1f70927bc08319": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_WorkerGlobalScope_2f1f70927bc08319"](p0i32);
/******/ 					},
/******/ 					"__wbindgen_object_clone_ref": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_object_clone_ref"](p0i32);
/******/ 					},
/******/ 					"__wbg_new_59cb74e423758ede": function() {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_new_59cb74e423758ede"]();
/******/ 					},
/******/ 					"__wbg_stack_558ba5917b466edd": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_stack_558ba5917b466edd"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_error_4bb6c2a97407129a": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_error_4bb6c2a97407129a"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_cb_drop": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_cb_drop"](p0i32);
/******/ 					},
/******/ 					"__wbg_fetch_99437343e599cf5a": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_fetch_99437343e599cf5a"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_postMessage_952d6d0f2eb1d008": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_postMessage_952d6d0f2eb1d008"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_string_new": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_string_new"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_fetch_72d8bdd672493862": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_fetch_72d8bdd672493862"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_instanceof_Response_692fcbbfbfd64a77": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_instanceof_Response_692fcbbfbfd64a77"](p0i32);
/******/ 					},
/******/ 					"__wbg_ok_015f6396ebd3dd20": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_ok_015f6396ebd3dd20"](p0i32);
/******/ 					},
/******/ 					"__wbg_arrayBuffer_02aa93c3b506b861": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_arrayBuffer_02aa93c3b506b861"](p0i32);
/******/ 					},
/******/ 					"__wbg_headers_7fa1db3bfec6d840": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_headers_7fa1db3bfec6d840"](p0i32);
/******/ 					},
/******/ 					"__wbg_newwithstrandinit_ddb9c1fa02972c36": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_newwithstrandinit_ddb9c1fa02972c36"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_set_6676dcd9a717a04d": function(p0i32,p1i32,p2i32,p3i32,p4i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_set_6676dcd9a717a04d"](p0i32,p1i32,p2i32,p3i32,p4i32);
/******/ 					},
/******/ 					"__wbg_new_f59cbefd64f2876f": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_new_f59cbefd64f2876f"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_newnoargs_ab5e899738c0eff4": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_newnoargs_ab5e899738c0eff4"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_call_ab183a630df3a257": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_call_ab183a630df3a257"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_call_7a2b5e98ac536644": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_call_7a2b5e98ac536644"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_new_dc5b27cfd2149b8f": function() {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_new_dc5b27cfd2149b8f"]();
/******/ 					},
/******/ 					"__wbg_new_bae826039151b559": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_new_bae826039151b559"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_resolve_9b0f9ddf5f89cb1e": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_resolve_9b0f9ddf5f89cb1e"](p0i32);
/******/ 					},
/******/ 					"__wbg_then_b4358f6ec1ee6657": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_then_b4358f6ec1ee6657"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_then_3d9a54b0affdf26d": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_then_3d9a54b0affdf26d"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_self_77eca7b42660e1bb": function() {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_self_77eca7b42660e1bb"]();
/******/ 					},
/******/ 					"__wbg_window_51dac01569f1ba70": function() {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_window_51dac01569f1ba70"]();
/******/ 					},
/******/ 					"__wbg_globalThis_34bac2d08ebb9b58": function() {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_globalThis_34bac2d08ebb9b58"]();
/******/ 					},
/******/ 					"__wbg_global_1c436164a66c9c22": function() {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_global_1c436164a66c9c22"]();
/******/ 					},
/******/ 					"__wbg_buffer_bc64154385c04ac4": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_buffer_bc64154385c04ac4"](p0i32);
/******/ 					},
/******/ 					"__wbg_new_22a33711cf65b661": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_new_22a33711cf65b661"](p0i32);
/******/ 					},
/******/ 					"__wbg_set_b29de3f25280c6ec": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_set_b29de3f25280c6ec"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_length_e9f6f145de2fede5": function(p0i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_length_e9f6f145de2fede5"](p0i32);
/******/ 					},
/******/ 					"__wbg_newwithbyteoffsetandlength_4fec8b44f7ca5e63": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_newwithbyteoffsetandlength_4fec8b44f7ca5e63"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_newwithbyteoffsetandlength_193d0d8755287921": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_newwithbyteoffsetandlength_193d0d8755287921"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_set_3afd31f38e771338": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbg_set_3afd31f38e771338"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbindgen_debug_string": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_debug_string"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_throw": function(p0i32,p1i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_throw"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_memory": function() {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_memory"]();
/******/ 					},
/******/ 					"__wbindgen_closure_wrapper545": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["../pkg/shp_contour_wasm_bg.js"].exports["__wbindgen_closure_wrapper545"](p0i32,p1i32,p2i32);
/******/ 					}
/******/ 				}
/******/ 			};
/******/ 		},
/******/ 	};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId]) {
/******/ 			return installedModules[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/ 	// This file contains only the entry chunk.
/******/ 	// The chunk loading function for additional chunks
/******/ 	__webpack_require__.e = function requireEnsure(chunkId) {
/******/ 		var promises = [];
/******/ 		promises.push(Promise.resolve().then(function() {
/******/ 			// "1" is the signal for "already loaded"
/******/ 			if(!installedChunks[chunkId]) {
/******/ 				importScripts(__webpack_require__.p + "" + chunkId + ".worker.js");
/******/ 			}
/******/ 		}));
/******/
/******/ 		// Fetch + compile chunk loading for webassembly
/******/
/******/ 		var wasmModules = {"0":["../pkg/shp_contour_wasm_bg.wasm"]}[chunkId] || [];
/******/
/******/ 		wasmModules.forEach(function(wasmModuleId) {
/******/ 			var installedWasmModuleData = installedWasmModules[wasmModuleId];
/******/
/******/ 			// a Promise means "currently loading" or "already loaded".
/******/ 			if(installedWasmModuleData)
/******/ 				promises.push(installedWasmModuleData);
/******/ 			else {
/******/ 				var importObject = wasmImportObjects[wasmModuleId]();
/******/ 				var req = fetch(__webpack_require__.p + "" + {"../pkg/shp_contour_wasm_bg.wasm":"3200c99078617935be9a"}[wasmModuleId] + ".module.wasm");
/******/ 				var promise;
/******/ 				if(importObject instanceof Promise && typeof WebAssembly.compileStreaming === 'function') {
/******/ 					promise = Promise.all([WebAssembly.compileStreaming(req), importObject]).then(function(items) {
/******/ 						return WebAssembly.instantiate(items[0], items[1]);
/******/ 					});
/******/ 				} else if(typeof WebAssembly.instantiateStreaming === 'function') {
/******/ 					promise = WebAssembly.instantiateStreaming(req, importObject);
/******/ 				} else {
/******/ 					var bytesPromise = req.then(function(x) { return x.arrayBuffer(); });
/******/ 					promise = bytesPromise.then(function(bytes) {
/******/ 						return WebAssembly.instantiate(bytes, importObject);
/******/ 					});
/******/ 				}
/******/ 				promises.push(installedWasmModules[wasmModuleId] = promise.then(function(res) {
/******/ 					return __webpack_require__.w[wasmModuleId] = (res.instance || res).exports;
/******/ 				}));
/******/ 			}
/******/ 		});
/******/ 		return Promise.all(promises);
/******/ 	};
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, { enumerable: true, get: getter });
/******/ 		}
/******/ 	};
/******/
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = function(exports) {
/******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		}
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/
/******/ 	// create a fake namespace object
/******/ 	// mode & 1: value is a module id, require it
/******/ 	// mode & 2: merge all properties of value into the ns
/******/ 	// mode & 4: return value when already ns object
/******/ 	// mode & 8|1: behave like require
/******/ 	__webpack_require__.t = function(value, mode) {
/******/ 		if(mode & 1) value = __webpack_require__(value);
/******/ 		if(mode & 8) return value;
/******/ 		if((mode & 4) && typeof value === 'object' && value && value.__esModule) return value;
/******/ 		var ns = Object.create(null);
/******/ 		__webpack_require__.r(ns);
/******/ 		Object.defineProperty(ns, 'default', { enumerable: true, value: value });
/******/ 		if(mode & 2 && typeof value != 'string') for(var key in value) __webpack_require__.d(ns, key, function(key) { return value[key]; }.bind(null, key));
/******/ 		return ns;
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// object with all WebAssembly.instance exports
/******/ 	__webpack_require__.w = {};
/******/
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = "./bootstrap-worker.js");
/******/ })
/************************************************************************/
/******/ ({

/***/ "./bootstrap-worker.js":
/*!*****************************!*\
  !*** ./bootstrap-worker.js ***!
  \*****************************/
/*! no static exports found */
/***/ (function(module, exports, __webpack_require__) {

eval("// A dependency graph that contains any wasm must all be imported\r\n// asynchronously. This `bootstrap.js` file does the single async import, so\r\n// that no one else needs to worry about it again.\r\n__webpack_require__.e(/*! import() */ 0).then(__webpack_require__.bind(null, /*! ./index-worker.js */ \"./index-worker.js\"))\r\n  .catch(e => console.error(\"Error importing `index-worker.js`:\", e));\r\n\n\n//# sourceURL=webpack:///./bootstrap-worker.js?");

/***/ })

/******/ });