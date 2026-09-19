window.__ModuleLoader__.load({
	id: "@the-heart-fickle/dsh-session-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var Button = primitives.Button;
		var Modal = primitives.Modal;
		var IconRefreshOutline16 = primitives.IconRefreshOutline16;
		var IconArchiveOutline20 = primitives.IconArchiveOutline20;
		var IconWarningOutline16 = primitives.IconWarningOutline16;

		// ── locale: rewind ──────────────────────────────────────────────
		var NS_REWIND = "dsh-session-manager-rewind";
		var rewindZh = {
			open: "回退",
			title: "回退对话",
			subtitle: "选择一条历史用户消息，对话将回退到这条消息之前",
			close: "关闭",
			cancel: "取消",
			confirm: "确认回退",
			loading: "载入回退点…",
			empty: "没有可回退的历史用户消息",
			imageMessage: "[图片消息]",
			selectedTitle: "将回退到这条消息？",
			selectedHint: "对话会从这里之前重新开始，原文会放回输入框供你重新编辑。",
			dropsOpenTurns: "注意：它前面未正常结束的回合会被一并撤销。",
			confirming: "回退中…",
			errorTitle: "回退失败",
			errorGeneric: "回退失败，请稍后重试。",
			shortcut: "Ctrl/Cmd+Shift+Z",
		};
		var rewindEn = {
			open: "Rewind",
			title: "Rewind conversation",
			subtitle: "Pick a past user message; the conversation rewinds to just before it",
			close: "Close",
			cancel: "Cancel",
			confirm: "Rewind",
			loading: "Loading rewind points…",
			empty: "No user messages to rewind to",
			imageMessage: "[image message]",
			selectedTitle: "Rewind to this message?",
			selectedHint: "The conversation restarts before this message; its text will be restored to the input for editing.",
			dropsOpenTurns: "Note: unfinished turns before it will be discarded as well.",
			confirming: "Rewinding…",
			errorTitle: "Rewind failed",
			errorGeneric: "Rewind failed. Please try again.",
			shortcut: "Ctrl/Cmd+Shift+Z",
		};

		// ── locale: archive ─────────────────────────────────────────────
		var NS_ARCHIVE = "dsh-session-manager-archive";
		var archiveZh = {
			open: "归档会话",
			title: "管理归档会话",
			subtitle: "恢复会话到工作区，或从磁盘彻底删除",
			close: "关闭",
			empty: "没有已归档的会话",
			loading: "加载中…",
			loadFailed: "加载失败",
			restore: "恢复",
			restoring: "恢复中…",
			delete: "删除",
			deleting: "删除中…",
			deleteAll: "删除全部归档会话",
			deleteAllUngrouped: "删除全部未分组归档会话",
			deletingAll: "正在删除…",
			deletingAllUngrouped: "正在删除…",
			confirmDelete: "确定要彻底删除这个会话吗？日志文件也会被删除，此操作不可撤销。",
			confirmDeleteAll: "确定要删除全部归档会话吗？所有对应日志文件都会被删除，此操作不可撤销。",
			confirmDeleteAllUngrouped: "确定要删除全部未分组的归档会话吗？所有对应日志文件都会被删除，此操作不可撤销。",
			deleteAllPartial: "{count} 个会话删除失败",
			missing: "文件不存在",
			live: "会话仍在运行，无法删除",
			liveOpen: "已打开",
			running: "运行中",
			operationFailed: "操作失败",
			untitled: "未命名会话",
			ungrouped: "未分组",
			tableTitle: "标题",
			tableWorkspace: "工作区",
			tableCreated: "创建时间",
			tableSize: "大小",
			tableStatus: "状态",
			tableActions: "操作"
		};
		var archiveEn = {
			open: "Archived",
			title: "Archived sessions",
			subtitle: "Restore sessions to the workspace or permanently delete them",
			close: "Close",
			empty: "No archived sessions",
			loading: "Loading…",
			loadFailed: "Failed to load",
			restore: "Restore",
			restoring: "Restoring…",
			delete: "Delete",
			deleting: "Deleting…",
			deleteAll: "Delete all archived sessions",
			deleteAllUngrouped: "Delete all ungrouped archived sessions",
			deletingAll: "Deleting…",
			deletingAllUngrouped: "Deleting…",
			confirmDelete: "Permanently delete this session? Its log file will also be removed. This cannot be undone.",
			confirmDeleteAll: "Delete all archived sessions? All corresponding log files will be removed. This cannot be undone.",
			confirmDeleteAllUngrouped: "Delete all ungrouped archived sessions? All corresponding log files will be removed. This cannot be undone.",
			deleteAllPartial: "{count} session(s) failed to delete",
			missing: "File missing",
			live: "Session is still running and cannot be deleted",
			liveOpen: "Open",
			running: "Running",
			operationFailed: "Operation failed",
			untitled: "Untitled session",
			ungrouped: "Ungrouped",
			tableTitle: "Title",
			tableWorkspace: "Workspace",
			tableCreated: "Created",
			tableSize: "Size",
			tableStatus: "Status",
			tableActions: "Actions"
		};

		// ── shared helpers ──────────────────────────────────────────────
		function formatTime(ts) {
			if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
			try {
				return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			} catch (_) {
				return "";
			}
		}

		function formatBytes(n) {
			if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}

		function formatDate(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
			try {
				return new Date(ms).toLocaleString();
			} catch (_) {
				return "";
			}
		}

		// ── 适配层（client 半边）：官方 client 服务触点的唯一汇聚点 ────────
		function requestJson(path, init) {
			return fetch("/api/session-manager/" + path, init).then(function (res) {
				return res.json()
					.catch(function () { return { ok: false, message: "bad response" }; })
					.then(function (data) {
						if (!res.ok || data.ok === false) {
							throw new Error(data.message || data.error || "request failed");
						}
						return data;
					});
			});
		}

		function postJson(path, body) {
			return requestJson(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
		}

		// 与 host 半边（lib/dsh-adapter.js → lib/archive.js）对称：整个 client
		// 半边只有本函数读官方 client 服务（会话目录 / 会话导航 / 输入框），
		// 组件一律只消费它返回的 rewind / archives 能力。DSH 客户端服务改名、
		// 搬家、换签名都在这里消化一次。
		//
		// 为什么不直接用 @dsh-std/adapter-dsh：0.1.1-rc.2 的 SessionHistory
		// 只有 read/follow，没有 rewind 的 fork 边界语义，也没有归档删除；
		// 标准通道因此在 lib/std-host.js 里降级为 backend-unavailable
		// （BUGS.md S10 备注）。dsh-std 补上这些语义前，本文件就是本插件
		// 自己的适配层，出参一经定下即冻结。
		//
		// 0.1.6 在此吸收的两处形状变化：
		// - 会话打开不再走 ISessions 的 open 方法（0.1.6 已无此方法），而是
		//   官方会话导航服务的 openSession(id)（官方 ui-chat 的 forkAt 同款）；
		// - “当前会话”不再是会话列表快照上的 current 字段，而是会话目录里
		//   retainedBy.mainView > 0 的那一行（官方 ui-agent-preset 同判据）。
		function createClientAdapter(ctx) {
			var sessions = ctx.sessions;
			var uiWorkspace = ctx.uiWorkspace;
			var conversation = ctx.conversation;

			// 会话标题取自客户端会话目录（官方归档页同源，durable title 缺失
			// 时留 null）：宿主不再为每条归档会话读日志或投影缓存。
			function summaryOf(sessionId) {
				return sessions.list.getSnapshot().byId[sessionId];
			}

			return {
				// 回退：host 扫描日志枚举回退点 → 官方 fork 重建分支 → 打开子
				// 会话、草稿回填、清空种子回放继承来的排队消息。
				rewind: {
					entries: function (sessionId) { return postJson("rewind/entries", { sessionId: sessionId }); },
					fork: function (sessionId, atSeq) {
						return sessions.fork({ sessionId: sessionId, atSeq: atSeq, increaseTitle: true });
					},
					open: function (sessionId) { uiWorkspace.openSession(sessionId); },
					// 草稿只能写进已被 retain 的会话（input.for 要求 live scope），
					// 所以调用方必须排在 open 之后。
					restoreDraft: function (sessionId, text) {
						var scope = sessions.scope(sessionId);
						if (scope === undefined || conversation === undefined) return;
						conversation.input.for(scope).setDraft(text);
					},
					drain: function (sessionId) {
						postJson("rewind/drain", { sessionId: sessionId }).catch(function () { });
					},
					current: function () {
						var state = sessions.list.getSnapshot();
						for (var i = 0; i < state.ids.length; i++) {
							var summary = summaryOf(state.ids[i]);
							if (summary !== undefined && (summary.retainedBy.mainView || 0) > 0) return state.ids[i];
						}
						return undefined;
					}
				},
				archives: {
					list: function () { return requestJson("archives/list"); },
					unarchive: function (sessionId) { return postJson("archives/unarchive", { sessionId: sessionId }); },
					remove: function (sessionId) { return postJson("archives/delete", { sessionId: sessionId }); },
					removeAll: function () { return postJson("archives/delete-all", {}); },
					removeUngrouped: function () { return postJson("archives/delete-ungrouped", {}); },
					title: function (sessionId) {
						var summary = summaryOf(sessionId);
						return summary === undefined ? null : (summary.title ?? null);
					}
				}
			};
		}

		// ── rewind helpers ──────────────────────────────────────────────
		// DSH 0.1.x 的聊天窗口是分页窗口（首屏尾页 50 条 surface 消息，
		// loadOlder 每次 prepend 50 条），聊天投影里只有已加载的事件。
		// 回退列表因此不读投影：弹窗打开时向 host 拉取「日志全量真实用户输入」
		// （lib/rewind-entries.js：source.kind==="user" 的 user/message），
		// 无论窗口加载到哪都能列出全部回退点（BUGS.md S1 / SPEC.md §1.2）。
		//
		// fork 边界由服务端逐条给出（boundary）= 选中输入所在 turn 之前最后一个
		// turn/end；服务端还用 dropsOpenTurns 标出「边界与选中回合之间夹着未闭合
		// 回合」的条目 —— fork 只能切到边界的下一个 turn/start，那些未闭合回合
		// 会被一并撤销，弹窗据此提示。压缩之前的输入不进入列表（BUGS.md S8/S9）。
		// 列表按新 → 旧排序。
		function toEntries(inputs) {
			var entries = [];
			for (var j = 0; j < inputs.length; j++) {
				if (inputs[j].boundary === null || inputs[j].boundary === undefined) continue;
				entries.push({
					key: "r" + inputs[j].seq,
					boundary: inputs[j].boundary,
					turn: inputs[j].turn,
					text: inputs[j].text,
					time: inputs[j].time,
					dropsOpenTurns: inputs[j].dropsOpenTurns === true,
				});
			}
			entries.reverse(); // 新 → 旧
			return entries;
		}

		// ── 跨组件 opener 注册表：让全局快捷键能打开当前会话的 rewind 选择器
		var rewindOpeners = new Map();
		function requestRewindOpen(sessionId) {
			var fn = sessionId === undefined || sessionId === null ? undefined : rewindOpeners.get(sessionId);
			if (fn) fn();
		}

		// ── RewindModal ─────────────────────────────────────────────────
		function RewindModal(props) {
			var selectedState = React.useState(null);
			var selected = selectedState[0];
			var setSelected = selectedState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var entriesState = React.useState({ phase: "loading", items: [], error: null });
			var entries = entriesState[0];
			var setEntries = entriesState[1];

			React.useEffect(function () {
				if (!props.open) return undefined;
				setSelected(null);
				setBusy(false);
				setError(null);
				setEntries({ phase: "loading", items: [], error: null });
				var alive = true;
				props.rewind.entries(props.sessionId)
					.then(function (data) {
						if (alive) setEntries({ phase: "ready", items: toEntries(data.inputs || []), error: null });
					})
					.catch(function (error) {
						if (!alive) return;
						setEntries({
							phase: "error",
							items: [],
							error: error && error.message ? error.message : String(error)
						});
					});
				return function () { alive = false; };
			}, [props.open, props.sessionId]);

			function doRewind() {
				if (!selected || busy) return;
				setBusy(true);
				setError(null);
				props.rewind
					.fork(props.sessionId, selected.boundary)
					.then(function (childId) {
						props.rewind.open(childId);
						try {
							props.rewind.restoreDraft(childId, selected.text);
						} catch (_) { }
						props.rewind.drain(childId);
						props.onClose();
					})
					.catch(function (err) {
						setError((err && err.message) || props.t("errorGeneric"));
						setBusy(false);
					});
			}

			function handleClose() {
				if (!busy) props.onClose();
			}

			var footer = React.createElement(React.Fragment, null,
				React.createElement(Button, {
					variant: "outline",
					onClick: handleClose,
					disabled: busy
				}, props.t("cancel")),
				React.createElement(Button, {
					variant: "primary",
					onClick: doRewind,
					disabled: !selected || busy
				}, busy ? props.t("confirming") : props.t("confirm"))
			);

			var list = [];
			if (entries.phase === "loading") {
				list.push(React.createElement("div", { key: "loading", className: "dsh-rewind-empty" }, props.t("loading")));
			} else if (entries.phase === "error") {
				list.push(React.createElement("div", { key: "load-error", className: "dsh-rewind-empty" },
					props.t("errorTitle") + ": " + entries.error
				));
			} else if (entries.items.length === 0) {
				list.push(React.createElement("div", { key: "empty", className: "dsh-rewind-empty" }, props.t("empty")));
			} else {
				entries.items.forEach(function (entry) {
					var isSelected = selected !== null && selected.key === entry.key;
					list.push(React.createElement("button", {
						key: entry.key,
						type: "button",
						className: "dsh-rewind-item" + (isSelected ? " dsh-rewind-item-selected" : ""),
						onClick: function () {
							setSelected(entry);
						},
						"aria-pressed": isSelected || undefined
					},
						React.createElement("span", { className: "dsh-rewind-item-text" },
							entry.text || props.t("imageMessage")
						),
						entry.dropsOpenTurns && React.createElement("span", {
							className: "dsh-rewind-item-warn",
							title: props.t("dropsOpenTurns")
						}, React.createElement(IconWarningOutline16, { size: 14 })),
						React.createElement("span", { className: "dsh-rewind-item-meta" },
							"#" + entry.turn + (entry.time ? " · " + formatTime(entry.time) : "")
						)
					));
				});
			}

			var body = [
				React.createElement("div", { key: "list", className: "dsh-rewind-list" }, list),
				selected !== null && React.createElement("div", { key: "preview", className: "dsh-rewind-preview" },
					React.createElement("div", { className: "dsh-rewind-preview-title" }, props.t("selectedTitle")),
					React.createElement("div", { className: "dsh-rewind-preview-text" }, selected.text || props.t("imageMessage")),
					React.createElement("div", { className: "dsh-rewind-preview-hint" }, props.t("selectedHint")),
					selected.dropsOpenTurns && React.createElement("div", { className: "dsh-rewind-preview-warn" },
						React.createElement(IconWarningOutline16, { size: 14 }),
						React.createElement("span", null, props.t("dropsOpenTurns"))
					)
				),
				error !== null && React.createElement("div", { key: "error", className: "dsh-rewind-error" },
					React.createElement(IconWarningOutline16, { size: 14 }),
					React.createElement("span", null, props.t("errorTitle") + ": " + error)
				)
			];

			return React.createElement(Modal, {
				open: props.open,
				onClose: handleClose,
				title: props.t("title"),
				description: props.t("subtitle"),
				closeLabel: props.t("close"),
				footer: footer,
				contentClassName: "dsh-rewind-content"
			}, body);
		}

		// ── RewindHeaderAction ─────────────────────────────────────────
		function RewindHeaderAction(props) {
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];

			React.useEffect(function () {
				var opener = function () { setOpen(true); };
				rewindOpeners.set(props.sessionId, opener);
				return function () {
					if (rewindOpeners.get(props.sessionId) === opener) rewindOpeners.delete(props.sessionId);
				};
			}, [props.sessionId]);

			React.useSyncExternalStore(
				function (cb) { return props.locale.subscribe(cb); },
				function () { return props.locale.getSnapshot(); }
			);

			return React.createElement(React.Fragment, null,
				React.createElement(Button, {
					size: "sm",
					icon: React.createElement(IconRefreshOutline16, { size: 16 }),
					onClick: function () { setOpen(true); },
					"aria-label": props.t("open") + " (" + props.t("shortcut") + ")",
					title: props.t("open") + " (" + props.t("shortcut") + ")"
				}, props.t("open")),
				React.createElement(RewindModal, {
					open: open,
					onClose: function () { setOpen(false); },
					sessionId: props.sessionId,
					rewind: props.rewind,
					t: props.t
				})
			);
		}

		// ── ArchiveManagerModal ────────────────────────────────────────
		function ArchiveManagerModal(props) {
			var t = props.t;
			var open = props.open;
			var onClose = props.onClose;
			var archives = props.archives;

			var stateState = React.useState({ phase: "idle", items: [], error: null });
			var state = stateState[0];
			var setState = stateState[1];
			var busyState = React.useState(null);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var deleteAllState = React.useState(false);
			var deleteAllBusy = deleteAllState[0];
			var setDeleteAllBusy = deleteAllState[1];
			var deleteAllUngroupedState = React.useState(false);
			var deleteAllUngroupedBusy = deleteAllUngroupedState[0];
			var setDeleteAllUngroupedBusy = deleteAllUngroupedState[1];
			var sortState = React.useState({ key: null, dir: "asc" });
			var sort = sortState[0];
			var setSort = sortState[1];

			var load = React.useCallback(async function (silent) {
				if (!silent) {
					setState(function (s) { return { phase: "loading", items: s.items, error: null }; });
				}
				try {
					var data = await archives.list();
					// 标题来自客户端会话目录（宿主只回报磁盘/记账事实）
					var items = (data.archived || []).map(function (item) {
						return Object.assign({}, item, { title: archives.title(item.id) });
					});
					setState({ phase: "ready", items: items, error: null });
				} catch (error) {
					var message = error && error.message ? error.message : String(error);
					setState(function (s) {
						return silent ? Object.assign({}, s, { error: message }) : { phase: "error", items: [], error: message };
					});
				}
			}, []);

			React.useEffect(function () {
				if (open) load();
			}, [open, load]);

			// 删除/恢复只改宿主状态，客户端视图由 host 事件驱动（删除会发
			// api-session/removed，归档集合由 workspace 流广播）；重列一次本
			// 弹窗自己的列表即可，不再触发整库 session.list 刷新。
			async function afterMutation() {
				await load(true);
			}

			async function handleRestore(id) {
				if (busy !== null) return;
				setBusy(id);
				try {
					await archives.unarchive(id);
					setState(function (s) { return Object.assign({}, s, { items: s.items.filter(function (x) { return x.id !== id; }) }); });
					await afterMutation();
				} catch (error) {
					setState(function (s) { return Object.assign({}, s, { error: error && error.message ? error.message : String(error) }); });
				} finally {
					setBusy(null);
				}
			}

			async function handleDelete(id) {
				if (busy !== null) return;
				if (!window.confirm(t("confirmDelete"))) return;
				setBusy(id);
				try {
					await archives.remove(id);
					setState(function (s) { return Object.assign({}, s, { items: s.items.filter(function (x) { return x.id !== id; }) }); });
					await afterMutation();
				} catch (error) {
					setState(function (s) { return Object.assign({}, s, { error: error && error.message ? error.message : String(error) }); });
				} finally {
					setBusy(null);
				}
			}

			async function handleDeleteAll() {
				if (deleteAllBusy || deleteAllUngroupedBusy || busy !== null) return;
				if (!window.confirm(t("confirmDeleteAll"))) return;
				setDeleteAllBusy(true);
				try {
					var data = await archives.removeAll();
					var failed = (data.results || []).filter(function (r) { return !r.ok; });
					await afterMutation();
					if (failed.length > 0) {
						throw new Error(t("deleteAllPartial", { count: failed.length }));
					}
				} catch (error) {
					setState(function (s) { return Object.assign({}, s, { error: error && error.message ? error.message : String(error) }); });
				} finally {
					setDeleteAllBusy(false);
				}
			}

			async function handleDeleteAllUngrouped() {
				if (deleteAllUngroupedBusy || deleteAllBusy || busy !== null) return;
				if (!window.confirm(t("confirmDeleteAllUngrouped"))) return;
				setDeleteAllUngroupedBusy(true);
				try {
					var data = await archives.removeUngrouped();
					var failed = (data.results || []).filter(function (r) { return !r.ok; });
					await afterMutation();
					if (failed.length > 0) {
						throw new Error(t("deleteAllPartial", { count: failed.length }));
					}
				} catch (error) {
					setState(function (s) { return Object.assign({}, s, { error: error && error.message ? error.message : String(error) }); });
				} finally {
					setDeleteAllUngroupedBusy(false);
				}
			}

			function toggleSort(key) {
				setSort(function (s) {
					if (s.key === key) return { key: key, dir: s.dir === "asc" ? "desc" : "asc" };
					return { key: key, dir: "asc" };
				});
			}

			function getSortValue(item, key) {
				if (key === "title") return item.title && item.title !== item.id ? item.title : item.id || "";
				if (key === "workspace") return item.workspaceTitle || item.cwd || "";
				if (key === "createdAt") return item.createdAt || 0;
				if (key === "size") return item.size == null ? -1 : item.size;
				if (key === "status") {
					var statuses = [];
					if (!item.exists) statuses.push(t("missing"));
					if (item.running) statuses.push(t("running"));
					else if (item.live) statuses.push(t("liveOpen"));
					return statuses.join(" · ");
				}
				return "";
			}

			var sortedItems = state.items;
			if (sort.key) {
				sortedItems = state.items.slice().sort(function (a, b) {
					var av = getSortValue(a, sort.key);
					var bv = getSortValue(b, sort.key);
					var cmp;
					if (typeof av === "number" && typeof bv === "number") {
						cmp = av - bv;
					} else {
						cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
					}
					return sort.dir === "asc" ? cmp : -cmp;
				});
			}

			var footer = React.createElement("div", { className: "dsh-archive-footer" },
				React.createElement("div", { className: "dsh-archive-footer-side" },
					state.items.some(function (item) { return !item.workspaceId; }) && React.createElement(Button, {
						variant: "outline",
						className: "dsh-archive-danger",
						onClick: handleDeleteAllUngrouped,
						disabled: deleteAllUngroupedBusy || deleteAllBusy || busy !== null
					}, deleteAllUngroupedBusy ? t("deletingAllUngrouped") : t("deleteAllUngrouped")),
					state.items.length > 0 && React.createElement(Button, {
						variant: "outline",
						className: "dsh-archive-danger",
						onClick: handleDeleteAll,
						disabled: deleteAllUngroupedBusy || deleteAllBusy || busy !== null
					}, deleteAllBusy ? t("deletingAll") : t("deleteAll"))
				),
				React.createElement("div", { className: "dsh-archive-footer-side" },
					React.createElement(Button, {
						variant: "outline",
						onClick: onClose
					}, t("close"))
				)
			);

			var body = [];
			if (state.phase === "loading") {
				body.push(React.createElement("div", { key: "loading", className: "dsh-archive-empty" }, t("loading")));
			} else if (state.phase === "error") {
				body.push(React.createElement("div", { key: "error", className: "dsh-archive-error" },
					React.createElement(IconWarningOutline16, { size: 14 }),
					React.createElement("span", null, t("loadFailed") + ": " + state.error)
				));
			} else if (state.items.length === 0) {
				body.push(React.createElement("div", { key: "empty", className: "dsh-archive-empty" }, t("empty")));
			} else {
				body.push(React.createElement("div", { key: "list", className: "dsh-archive-list" },
					React.createElement("table", { className: "dsh-archive-table" },
						React.createElement("colgroup", null,
							React.createElement("col", { className: "dsh-archive-col-title" }),
							React.createElement("col", { className: "dsh-archive-col-workspace" }),
							React.createElement("col", { className: "dsh-archive-col-created" }),
							React.createElement("col", { className: "dsh-archive-col-size" }),
							React.createElement("col", { className: "dsh-archive-col-status" }),
							React.createElement("col", { className: "dsh-archive-col-actions" })
						),
						React.createElement("thead", null,
							React.createElement("tr", null,
								React.createElement("th", { className: "dsh-archive-th dsh-archive-col-title", "aria-sort": sort.key === "title" ? (sort.dir === "asc" ? "ascending" : "descending") : undefined },
									React.createElement("button", { type: "button", className: "dsh-archive-sort", onClick: function () { toggleSort("title"); } }, t("tableTitle") + (sort.key === "title" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""))
								),
								React.createElement("th", { className: "dsh-archive-th dsh-archive-col-workspace", "aria-sort": sort.key === "workspace" ? (sort.dir === "asc" ? "ascending" : "descending") : undefined },
									React.createElement("button", { type: "button", className: "dsh-archive-sort", onClick: function () { toggleSort("workspace"); } }, t("tableWorkspace") + (sort.key === "workspace" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""))
								),
								React.createElement("th", { className: "dsh-archive-th dsh-archive-col-created", "aria-sort": sort.key === "createdAt" ? (sort.dir === "asc" ? "ascending" : "descending") : undefined },
									React.createElement("button", { type: "button", className: "dsh-archive-sort", onClick: function () { toggleSort("createdAt"); } }, t("tableCreated") + (sort.key === "createdAt" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""))
								),
								React.createElement("th", { className: "dsh-archive-th dsh-archive-col-size", "aria-sort": sort.key === "size" ? (sort.dir === "asc" ? "ascending" : "descending") : undefined },
									React.createElement("button", { type: "button", className: "dsh-archive-sort", onClick: function () { toggleSort("size"); } }, t("tableSize") + (sort.key === "size" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""))
								),
								React.createElement("th", { className: "dsh-archive-th dsh-archive-col-status", "aria-sort": sort.key === "status" ? (sort.dir === "asc" ? "ascending" : "descending") : undefined },
									React.createElement("button", { type: "button", className: "dsh-archive-sort", onClick: function () { toggleSort("status"); } }, t("tableStatus") + (sort.key === "status" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""))
								),
								React.createElement("th", { className: "dsh-archive-th dsh-archive-col-actions" }, t("tableActions"))
							)
						),
						React.createElement("tbody", null,
							sortedItems.map(function (item) {
								var hasTitle = !!item.title && item.title !== item.id;
								var itemTitle = hasTitle ? item.title : t("untitled");
								var itemSub = hasTitle ? null : (item.id && item.id.length > 18 ? item.id.slice(0, 13) + "…" : item.id || "");
								var workspaceTitle = item.workspaceTitle || t("ungrouped");
								var workspaceSub = item.workspaceTitle ? null : (item.cwd || "");
								var date = formatDate(item.createdAt);
								var sizeText = formatBytes(item.size);
								var statuses = [];
								if (!item.exists) statuses.push(t("missing"));
								if (item.running) statuses.push(t("running"));
								else if (item.live) statuses.push(t("liveOpen"));
								var statusText = statuses.join(" · ");
								return React.createElement("tr", { key: item.id, className: "dsh-archive-tr" },
									React.createElement("td", { className: "dsh-archive-td" },
										React.createElement("div", { className: "dsh-archive-item-title", title: item.id || undefined }, itemTitle),
										itemSub && React.createElement("div", { className: "dsh-archive-item-sub" }, itemSub)
									),
									React.createElement("td", { className: "dsh-archive-td" },
										React.createElement("div", { className: "dsh-archive-item-title", title: item.cwd || undefined }, workspaceTitle),
										workspaceSub && React.createElement("div", { className: "dsh-archive-item-sub", title: workspaceSub }, workspaceSub)
									),
									React.createElement("td", { className: "dsh-archive-td dsh-archive-td-muted" }, date || ""),
									React.createElement("td", { className: "dsh-archive-td dsh-archive-td-muted" }, sizeText || ""),
									React.createElement("td", { className: "dsh-archive-td dsh-archive-td-muted" }, statusText || ""),
									React.createElement("td", { className: "dsh-archive-td dsh-archive-td-actions" },
										React.createElement("div", { className: "dsh-archive-item-actions" },
											React.createElement(Button, {
												variant: "outline",
												size: "sm",
												onClick: function () { handleRestore(item.id); },
												disabled: busy !== null || deleteAllBusy || !item.exists
											}, busy === item.id ? t("restoring") : t("restore")),
											React.createElement(Button, {
												variant: "outline",
												size: "sm",
												className: "dsh-archive-danger",
												onClick: function () { handleDelete(item.id); },
												disabled: busy !== null || deleteAllBusy || item.running,
												title: item.running ? t("running") : undefined
											}, busy === item.id ? t("deleting") : t("delete"))
										)
									)
								);
							})
						)
					)
				));
			}

			if (state.error !== null && state.phase !== "error") {
				body.push(React.createElement("div", { key: "op-error", className: "dsh-archive-error" },
					React.createElement(IconWarningOutline16, { size: 14 }),
					React.createElement("span", null, t("operationFailed") + ": " + state.error)
				));
			}

			return React.createElement(Modal, {
				open: open,
				onClose: onClose,
				title: t("title"),
				description: t("subtitle"),
				closeLabel: t("close"),
				className: "dsh-archive-modal",
				contentClassName: "dsh-archive-content",
				footer: footer
			}, body);
		}

		// ── ArchiveManagerButton ───────────────────────────────────────
		function ArchiveManagerButton(props) {
			var wide = props.wide;
			var t = props.t;
			var locale = props.locale;
			var archives = props.archives;
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];

			React.useSyncExternalStore(
				function (cb) { return locale.subscribe(cb); },
				function () { return locale.getSnapshot(); }
			);

			return React.createElement(React.Fragment, null,
				React.createElement("button", {
					type: "button",
					className: "dsh-archive-trigger" + (wide ? "" : " dsh-archive-trigger-rail"),
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": t("open"),
					title: t("open"),
					onClick: function () { setOpen(true); }
				},
					React.createElement(IconArchiveOutline20, { size: wide ? 16 : 18 }),
					wide && React.createElement("span", { className: "dsh-archive-trigger-label" }, t("open"))
				),
				React.createElement(ArchiveManagerModal, {
					open: open,
					onClose: function () { setOpen(false); },
					t: t,
					archives: archives
				})
			);
		}

		// ── styles ──────────────────────────────────────────────────────
		var CSS = [
			// rewind
			".dsh-rewind-content{display:flex;flex-direction:column;gap:12px;min-height:0}",
			".dsh-rewind-list{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;max-height:min(48vh,420px);overflow-y:auto;padding:2px}",
			".dsh-rewind-item{box-sizing:border-box;width:100%;min-height:44px;color:var(--dsw-alias-label-primary,#e6e8eb);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.04));cursor:pointer;border:1px solid transparent;border-radius:10px;align-items:center;gap:8px;padding:8px 10px;display:flex;font:inherit;text-align:left}",
			".dsh-rewind-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".dsh-rewind-item-selected{border-color:var(--dsw-alias-accent-primary,#4d9fff);background:var(--dsw-alias-interactive-bg-active,rgba(77,159,255,.12))}",
			".dsh-rewind-item-text{min-width:0;flex:1;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:13px;line-height:20px}",
			".dsh-rewind-item-warn{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-state-warn-primary,#e8a33d)}",
			".dsh-rewind-item-meta{flex:none;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;line-height:16px}",
			".dsh-rewind-empty{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:13px;line-height:20px;padding:12px 4px;text-align:center}",
			".dsh-rewind-preview{box-sizing:border-box;background:var(--dsw-specific-tip,rgba(255,255,255,.02));border:1px solid var(--dsw-alias-border-l1,#3a3f45);border-radius:10px;flex-direction:column;gap:4px;padding:10px 12px;display:flex}",
			".dsh-rewind-preview-title{color:var(--dsw-alias-label-primary,#e6e8eb);font-size:13px;font-weight:600;line-height:20px}",
			".dsh-rewind-preview-text{color:var(--dsw-alias-label-secondary,#c6cbd1);white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px;max-height:96px;overflow-y:auto}",
			".dsh-rewind-preview-hint{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px;line-height:18px}",
			".dsh-rewind-preview-warn{box-sizing:border-box;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-state-warn-primary,#e8a33d);font-size:12px;line-height:18px}",
			".dsh-rewind-error{box-sizing:border-box;color:var(--dsw-alias-state-error-primary,#ff6b6b);background:var(--dsw-alias-state-error-bg,rgba(255,107,107,.1));border:1px solid var(--dsw-alias-state-error-border,rgba(255,107,107,.3));border-radius:8px;align-items:center;gap:6px;padding:8px 10px;display:flex;font-size:12px;line-height:18px}",
			// archive
			// DSH 的 footer 容器只有 CSS-Modules 哈希类名，且 web 包与桌面包
			// 的哈希不同（选中哈希的规则在桌面上根本不生效，容器退回 flex
			// 默认的行排布，动作条目互相挤压 —— BUGS.md S10）。渲染器给每个
			// 席位都渲染稳定的可寻址锚点 <div data-slot="sidebar.footer.action"
			// style="display:contents">，用 :has(> …) 命中它的父容器即可跨构建
			// 生效（锚点是 display:contents，规则不会被锚点自身吃掉）。
			"div:has(> [data-slot=\"sidebar.footer.action\"]){flex-direction:column;gap:2px}",
			// 条目自身不锁定不可收缩的宽度：万一容器仍是行排布，条目随容器
			// 收缩而不是把相邻插件（如 dsh-context）挤成一个图标。
			".dsh-archive-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);min-width:0;height:34px;color:var(--dsw-alias-label-primary,#e6e8eb);background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}",
			".dsh-archive-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".dsh-archive-trigger.dsh-archive-trigger-rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}",
			".dsh-archive-trigger-label{white-space:nowrap;overflow:hidden}",
			".dsh-archive-modal{width:min(1024px,calc(100vw - 32px));max-height:min(70vh,640px)}",
			".dsh-archive-content{display:flex;flex-direction:column;gap:12px;min-height:0;flex:1;overflow:hidden}",
			".dsh-archive-modal .dsh-archive-content > div:last-child{display:flex;flex-direction:column;flex:1;min-height:0}",
			".dsh-archive-list{box-sizing:border-box;flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1,#3a3f45);border-radius:12px;background:var(--dsw-specific-tip,rgba(255,255,255,.02))}",
			".dsh-archive-table{width:100%;min-width:880px;border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:13px;line-height:20px}",
			".dsh-archive-th{box-sizing:border-box;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px;font-weight:500;line-height:18px;text-align:left;background:var(--dsw-alias-bg-layer-2,#1f2329);border-bottom:1px solid var(--dsw-alias-border-l1,#3a3f45);padding:8px 12px;position:sticky;top:0;z-index:1}",
			".dsh-archive-sort{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:inherit;cursor:pointer;text-align:left}",
			".dsh-archive-sort:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}",
			".dsh-archive-td{box-sizing:border-box;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l1,#3a3f45);padding:10px 12px;vertical-align:middle}",
			".dsh-archive-tr:last-child .dsh-archive-td{border-bottom:none}",
			".dsh-archive-tr:hover .dsh-archive-td{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04))}",
			".dsh-archive-td-muted{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-archive-td-actions{white-space:nowrap}",
			".dsh-archive-item-title{color:var(--dsw-alias-label-primary,#e6e8eb);font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			".dsh-archive-item-sub{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			".dsh-archive-item-actions{display:flex;align-items:center;gap:8px}",
			".dsh-archive-footer{box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".dsh-archive-footer-side{display:flex;align-items:center;gap:8px}",
			".dsh-archive-col-title{width:22%}",
			".dsh-archive-col-workspace{width:17%}",
			".dsh-archive-col-created{width:16%}",
			".dsh-archive-col-size{width:12%}",
			".dsh-archive-col-status{width:11%}",
			".dsh-archive-col-actions{width:22%}",
			".dsh-archive-empty{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:13px;line-height:20px;padding:12px 4px;text-align:center}",
			".dsh-archive-error{box-sizing:border-box;color:var(--dsw-alias-state-error-primary,#ff6b6b);background:var(--dsw-alias-state-error-bg,rgba(255,107,107,.1));border:1px solid var(--dsw-alias-state-error-border,rgba(255,107,107,.3));border-radius:8px;align-items:center;gap:6px;padding:8px 10px;display:flex;font-size:12px;line-height:18px}",
			".dsh-archive-danger{color:var(--dsw-alias-state-error-primary,#ff6b6b)!important}"
		].join("");

		// ── apply ─────────────────────────────────────────────────────────
		// 注入官方服务名（Cordis inject）：适配层把它们映射成插件自己的
		// rewind / archives 能力。uiWorkspace 是 0.1.6 里唯一能真正「切到某个
		// 会话」的服务（sessions 只负责目录与 retain）。
		var inject = ["locale", "slots", "sessions", "conversation", "uiWorkspace"];

		function apply(ctx) {
			ctx.effect(function () {
				ctx.locale.register(NS_REWIND, { zh: rewindZh, en: rewindEn });
				ctx.locale.register(NS_ARCHIVE, { zh: archiveZh, en: archiveEn });
			}, "dsh-session-manager: dictionaries");

			var tRewind = ctx.locale.bind(NS_REWIND);
			var tArchive = ctx.locale.bind(NS_ARCHIVE);
			var locale = ctx.locale;
			var slots = ctx.get("slots");
			if (slots === undefined) return;
			var adapter = createClientAdapter(ctx);

			ctx.effect(function () {
				if (typeof document === "undefined") return;
				var tagId = "dsh-session-manager/styles";
				var existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
				if (existing !== null) return;
				var tag = document.createElement("style");
				tag.dataset.plugin = "dsh-session-manager";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			});

			// 快捷键：Ctrl/Cmd+Shift+Z 打开当前会话的 rewind 选择器。
			ctx.effect(function () {
				if (typeof window === "undefined") return;
				function onKeyDown(event) {
					var mod = event.ctrlKey || event.metaKey;
					if (!mod || !event.shiftKey) return;
					if (event.key !== "Z" && event.key !== "z") return;
					var current = adapter.rewind.current();
					if (current === undefined) return;
					event.preventDefault();
					event.stopPropagation();
					requestRewindOpen(current);
				}
				window.addEventListener("keydown", onKeyDown, true);
				return function () {
					window.removeEventListener("keydown", onKeyDown, true);
				};
			});

			slots.inject("conversation.session.header.actions", function () {
				return slots.register({
					name: "conversation.session.header.actions",
					id: "rewind",
					order: 30,
					locale: NS_REWIND
				}, function (props) {
					return React.createElement(RewindHeaderAction, Object.assign({}, props, {
						t: tRewind,
						locale: locale,
						rewind: adapter.rewind
					}));
				});
			});

			slots.inject("sidebar.footer.action", function () {
				return slots.register({
					name: "sidebar.footer.action",
					id: "archive-manager",
					order: 100,
					locale: NS_ARCHIVE
				}, function (props) {
					return React.createElement(ArchiveManagerButton, Object.assign({}, props, {
						t: tArchive,
						locale: locale,
						archives: adapter.archives
					}));
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// 适配层工厂的测试出口（契约由 test/client-adapter.test.mjs 锁定）。
		exports.__test = { createClientAdapter: createClientAdapter };
		return module.exports;
	}
});
