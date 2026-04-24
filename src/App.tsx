import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";

type FilterType = "all" | "active" | "completed";
type TodoStatus = "active" | "partial" | "completed";

type ChildTodo = {
  id: string;
  text: string;
  description: string;
  completed: boolean;
  createdAt: number;
};

type Todo = {
  id: string;
  text: string;
  description: string;
  completed: boolean;
  createdAt: number;
  collapsed: boolean;
  children: ChildTodo[];
};

type ConfirmState = {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
};

type DateRange = {
  start: string;
  end: string;
};

type DragChildState = {
  parentId: string;
  childId: string;
} | null;

type DropPosition = "before" | "after";

type ParentDropHint = {
  targetId: string;
  position: DropPosition;
} | null;

type ChildDropHint = {
  parentId: string;
  targetChildId: string;
  position: DropPosition;
} | null;

const STORAGE_KEY = "my-todo-items-v1";
const THEME_KEY = "my-todo-theme-v1";
const DB_NAME = "my-todo-db";
const DB_VERSION = 1;
const STORE_NAME = "app-kv";
const TODOS_KEY = "todos";
const EXIT_ANIMATION_MS = 560;

function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // ignore
    }
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  });
  const [todos, setTodos] = useState<Todo[]>([]);
  const [currentFilter, setCurrentFilter] = useState<FilterType>("active");
  const [dateRange, setDateRange] = useState<DateRange>({ start: "", end: "" });
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarViewDate, setCalendarViewDate] = useState(new Date());
  const [titleInput, setTitleInput] = useState("");
  const [descInput, setDescInput] = useState("");
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false,
    title: "确认操作",
    message: "",
    confirmText: "确认",
  });
  const [exitingTodoIds, setExitingTodoIds] = useState<Set<string>>(new Set());
  const [dragParentId, setDragParentId] = useState<string | null>(null);
  const [dragChild, setDragChild] = useState<DragChildState>(null);
  const [parentDropHint, setParentDropHint] = useState<ParentDropHint>(null);
  const [childDropHint, setChildDropHint] = useState<ChildDropHint>(null);

  const [addingChildFor, setAddingChildFor] = useState<string | null>(null);
  const [editingParentDescFor, setEditingParentDescFor] = useState<string | null>(null);
  const [editingChildDescFor, setEditingChildDescFor] = useState<string | null>(null);
  const [childDrafts, setChildDrafts] = useState<Record<string, { text: string; description: string }>>({});
  const [parentDescDrafts, setParentDescDrafts] = useState<Record<string, string>>({});
  const [childDescDrafts, setChildDescDrafts] = useState<Record<string, string>>({});

  const dbPromiseRef = useRef<Promise<IDBDatabase> | null>(null);
  const todosRef = useRef<Todo[]>([]);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);
  const datePickerRef = useRef<HTMLDivElement | null>(null);
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const prevTopRef = useRef<Map<string, number>>(new Map());
  const skipNextFlipRef = useRef(false);

  useEffect(() => {
    todosRef.current = todos;
  }, [todos]);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const closeConfirmModal = useCallback((result: boolean) => {
    setConfirmState((prev) => ({ ...prev, open: false }));
    if (confirmResolverRef.current) {
      confirmResolverRef.current(result);
      confirmResolverRef.current = null;
    }
  }, []);

  const showConfirmModal = useCallback(
    (options: { title: string; message: string; confirmText: string }) => {
      setConfirmState({
        open: true,
        title: options.title,
        message: options.message,
        confirmText: options.confirmText,
      });
      return new Promise<boolean>((resolve) => {
        confirmResolverRef.current = resolve;
      });
    },
    []
  );

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of exitTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      exitTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    function onDocClick(event: globalThis.MouseEvent) {
      if (!calendarOpen) return;
      const target = event.target as Node;
      if (datePickerRef.current && !datePickerRef.current.contains(target)) {
        setCalendarOpen(false);
      }
    }

    function onDocKeydown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (confirmState.open) closeConfirmModal(false);
      if (calendarOpen) setCalendarOpen(false);
    }

    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKeydown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKeydown);
    };
  }, [calendarOpen, closeConfirmModal, confirmState.open]);

  const filteredTodos = useMemo(() => {
    return todos.filter((todo) => {
      const status = getTodoStatus(todo);
      if (currentFilter === "completed" && status !== "completed" && !exitingTodoIds.has(todo.id)) return false;
      if (currentFilter === "active" && status === "completed" && !exitingTodoIds.has(todo.id)) return false;
      if (!matchesDateRange(todo.createdAt, dateRange)) return false;
      return true;
    });
  }, [currentFilter, dateRange, todos, exitingTodoIds]);

  const leftCount = useMemo(
    () => todos.filter((todo) => getTodoStatus(todo) !== "completed").length,
    [todos]
  );
  const filteredTodoIdsKey = useMemo(
    () => filteredTodos.map((todo) => todo.id).join("|"),
    [filteredTodos]
  );

  useLayoutEffect(() => {
    if (dragParentId) return;

    const nextTop = new Map<string, number>();
    for (const todo of filteredTodos) {
      const el = itemRefs.current.get(todo.id);
      if (!el) continue;
      const currentTop = el.getBoundingClientRect().top + window.scrollY;
      nextTop.set(todo.id, currentTop);

      const prevTop = prevTopRef.current.get(todo.id);
      if (prevTop === undefined) continue;
      const delta = prevTop - currentTop;
      if (Math.abs(delta) < 1) continue;
      if (skipNextFlipRef.current) continue;

      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        {
          duration: 420,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        }
      );
    }

    prevTopRef.current = nextTop;
    skipNextFlipRef.current = false;
  }, [filteredTodoIdsKey, dragParentId]);

  const monthLabel = `${calendarViewDate.getFullYear()}年${String(
    calendarViewDate.getMonth() + 1
  ).padStart(2, "0")}月`;
  const calendarDays = buildCalendarDays(calendarViewDate, dateRange);

  async function initialize() {
    const loaded = await loadTodos();
    todosRef.current = loaded;
    setTodos(loaded);
  }

  async function commitTodos(updater: (prev: Todo[]) => Todo[]) {
    const next = updater(todosRef.current);
    todosRef.current = next;
    setTodos(next);
    await saveTodos(next);
    return next;
  }

  async function handleAddTodo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = titleInput.trim();
    const description = descInput.trim();
    if (!text) return;
    await commitTodos((prev) => [createTodo(text, description), ...prev]);
    setTitleInput("");
    setDescInput("");
  }

  async function handleToggleParent(todoId: string) {
    const before = todosRef.current.find((todo) => todo.id === todoId);
    const beforeStatus = before ? getTodoStatus(before) : null;
    const predictedAfter = predictParentToggleStatus(before);
    if (beforeStatus && shouldAnimateExit(beforeStatus, predictedAfter)) {
      beginExitAnimation(todoId);
    }

    await commitTodos((prev) =>
      prev.map((todo) => {
        if (todo.id !== todoId) return todo;
        if (todo.children.length === 0) {
          return { ...todo, completed: !todo.completed };
        }
        const allDone = todo.children.every((child) => child.completed);
        const next = !allDone;
        return {
          ...todo,
          children: todo.children.map((child) => ({ ...child, completed: next })),
        };
      })
    );
  }

  async function handleToggleChild(parentId: string, childId: string) {
    const before = todosRef.current.find((todo) => todo.id === parentId);
    const beforeStatus = before ? getTodoStatus(before) : null;
    const predictedAfter = predictChildToggleStatus(before, childId);
    if (beforeStatus && shouldAnimateExit(beforeStatus, predictedAfter)) {
      beginExitAnimation(parentId);
    }

    await commitTodos((prev) =>
      prev.map((todo) =>
        todo.id !== parentId
          ? todo
          : {
              ...todo,
              children: todo.children.map((child) =>
                child.id === childId ? { ...child, completed: !child.completed } : child
              ),
            }
      )
    );
  }

  async function handleDeleteParent(parentId: string) {
    const ok = await showConfirmModal({
      title: "确认删除这个任务？",
      message: "删除后将同时移除该任务下的所有子任务，无法恢复。",
      confirmText: "确认删除",
    });
    if (!ok) return;
    await commitTodos((prev) => prev.filter((todo) => todo.id !== parentId));
  }

  async function handleDeleteChild(parentId: string, childId: string) {
    const ok = await showConfirmModal({
      title: "确认删除这个子任务？",
      message: "删除后无法恢复。",
      confirmText: "确认删除",
    });
    if (!ok) return;
    await commitTodos((prev) =>
      prev.map((todo) =>
        todo.id !== parentId
          ? todo
          : { ...todo, children: todo.children.filter((child) => child.id !== childId) }
      )
    );
  }

  async function handleSaveParentDesc(parentId: string) {
    const draft = (parentDescDrafts[parentId] ?? "").trim();
    await commitTodos((prev) =>
      prev.map((todo) => (todo.id === parentId ? { ...todo, description: draft } : todo))
    );
    setEditingParentDescFor(null);
  }

  async function handleSaveChildDesc(parentId: string, childId: string) {
    const key = `${parentId}:${childId}`;
    const draft = (childDescDrafts[key] ?? "").trim();
    await commitTodos((prev) =>
      prev.map((todo) =>
        todo.id !== parentId
          ? todo
          : {
              ...todo,
              children: todo.children.map((child) =>
                child.id === childId ? { ...child, description: draft } : child
              ),
            }
      )
    );
    setEditingChildDescFor(null);
  }

  async function handleAddChild(parentId: string) {
    const draft = childDrafts[parentId];
    const text = (draft?.text ?? "").trim();
    const description = (draft?.description ?? "").trim();
    if (!text) return;

    const child: ChildTodo = {
      id: crypto.randomUUID(),
      text,
      description,
      completed: false,
      createdAt: Date.now(),
    };

    await commitTodos((prev) =>
      prev.map((todo) =>
        todo.id !== parentId ? todo : { ...todo, children: [...todo.children, child], collapsed: false }
      )
    );
    setChildDrafts((prev) => ({ ...prev, [parentId]: { text: "", description: "" } }));
    setAddingChildFor(null);
  }

  async function handleToggleCollapse(parentId: string) {
    await commitTodos((prev) =>
      prev.map((todo) => (todo.id === parentId ? { ...todo, collapsed: !todo.collapsed } : todo))
    );
  }

  async function handleClearCompleted() {
    const completedCount = todosRef.current.filter((todo) => getTodoStatus(todo) === "completed").length;
    if (completedCount === 0) {
      await showConfirmModal({
        title: "没有可清除的已完成任务",
        message: "当前没有已完成的顶级任务。",
        confirmText: "知道了",
      });
      return;
    }

    const ok = await showConfirmModal({
      title: "确认删除已完成任务？",
      message: "此操作会永久删除所有已完成的顶级任务，无法恢复。",
      confirmText: "确认删除",
    });
    if (!ok) return;
    await commitTodos((prev) => prev.filter((todo) => getTodoStatus(todo) !== "completed"));
  }

  function beginExitAnimation(todoId: string) {
    setExitingTodoIds((prev) => {
      if (prev.has(todoId)) return prev;
      const next = new Set(prev);
      next.add(todoId);
      return next;
    });

    const oldTimer = exitTimersRef.current.get(todoId);
    if (oldTimer) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(() => {
      setExitingTodoIds((prev) => {
        const next = new Set(prev);
        next.delete(todoId);
        return next;
      });
      exitTimersRef.current.delete(todoId);
    }, EXIT_ANIMATION_MS);
    exitTimersRef.current.set(todoId, timer);
  }

  function predictParentToggleStatus(todo: Todo | undefined): TodoStatus {
    if (!todo) return "active";
    if (todo.children.length === 0) {
      return todo.completed ? "active" : "completed";
    }
    const allDone = todo.children.every((child) => child.completed);
    return allDone ? "active" : "completed";
  }

  function predictChildToggleStatus(todo: Todo | undefined, childId: string): TodoStatus {
    if (!todo || todo.children.length === 0) return "active";
    const done = todo.children.filter((child) => child.completed).length;
    const target = todo.children.find((child) => child.id === childId);
    if (!target) return getTodoStatus(todo);
    const nextDone = target.completed ? done - 1 : done + 1;
    if (nextDone <= 0) return "active";
    if (nextDone >= todo.children.length) return "completed";
    return "partial";
  }

  function shouldAnimateExit(beforeStatus: TodoStatus | null, afterStatus: TodoStatus) {
    if (!beforeStatus) return false;
    if (currentFilter === "active") {
      return beforeStatus !== "completed" && afterStatus === "completed";
    }
    if (currentFilter === "completed") {
      return beforeStatus === "completed" && afterStatus !== "completed";
    }
    return false;
  }

  function handleParentContainerClick(todo: Todo, event: ReactMouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (todo.children.length === 0) return;
    if (target.closest(".todo-actions")) return;
    if (target.closest(".child-create-wrap")) return;
    if (target.closest(".todo-desc-edit-wrap")) return;
    if (target.closest(".subtodo-list")) return;
    if (target.closest("button, input, textarea, select, a, label")) return;
    void handleToggleCollapse(todo.id);
  }

  function moveItem<T>(items: T[], fromIndex: number, toIndex: number) {
    const next = [...items];
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    return next;
  }

  function moveItemByHint<T>(
    items: T[],
    fromIndex: number,
    targetIndex: number,
    position: DropPosition
  ) {
    const insertAtRaw = position === "before" ? targetIndex : targetIndex + 1;
    const insertAt = fromIndex < insertAtRaw ? insertAtRaw - 1 : insertAtRaw;
    if (fromIndex === insertAt) return items;
    return moveItem(items, fromIndex, insertAt);
  }

  function getDropPosition(event: React.DragEvent<HTMLElement>): DropPosition {
    const rect = event.currentTarget.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    return event.clientY < mid ? "before" : "after";
  }

  function handleParentDragStart(todoId: string) {
    setDragParentId(todoId);
    setParentDropHint(null);
  }

  function handleParentDragOver(event: React.DragEvent<HTMLLIElement>, targetId: string) {
    event.preventDefault();
    if (!dragParentId || dragParentId === targetId) {
      setParentDropHint(null);
      return;
    }
    const position = getDropPosition(event);
    setParentDropHint({ targetId, position });
  }

  async function handleParentDrop(targetId: string) {
    if (!dragParentId || dragParentId === targetId || !parentDropHint || parentDropHint.targetId !== targetId) {
      setDragParentId(null);
      setParentDropHint(null);
      return;
    }
    skipNextFlipRef.current = true;
    await commitTodos((prev) => {
      const from = prev.findIndex((item) => item.id === dragParentId);
      const to = prev.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return prev;
      return moveItemByHint(prev, from, to, parentDropHint.position);
    });
    setDragParentId(null);
    setParentDropHint(null);
  }

  function handleChildDragStart(parentId: string, childId: string) {
    setDragChild({ parentId, childId });
    setChildDropHint(null);
  }

  function handleChildDragOver(
    event: React.DragEvent<HTMLLIElement>,
    parentId: string,
    targetChildId: string
  ) {
    event.preventDefault();
    if (!dragChild || dragChild.parentId !== parentId || dragChild.childId === targetChildId) {
      setChildDropHint(null);
      return;
    }
    const position = getDropPosition(event);
    setChildDropHint({ parentId, targetChildId, position });
  }

  async function handleChildDrop(parentId: string, targetChildId: string) {
    if (
      !dragChild ||
      dragChild.parentId !== parentId ||
      dragChild.childId === targetChildId ||
      !childDropHint ||
      childDropHint.parentId !== parentId ||
      childDropHint.targetChildId !== targetChildId
    ) {
      setDragChild(null);
      setChildDropHint(null);
      return;
    }
    await commitTodos((prev) =>
      prev.map((todo) => {
        if (todo.id !== parentId) return todo;
        const from = todo.children.findIndex((item) => item.id === dragChild.childId);
        const to = todo.children.findIndex((item) => item.id === targetChildId);
        if (from < 0 || to < 0) return todo;
        return {
          ...todo,
          children: moveItemByHint(todo.children, from, to, childDropHint.position),
        };
      })
    );
    setDragChild(null);
    setChildDropHint(null);
  }

  return (
    <>
      <main className="app">
        <header className="app-header">
          <div className="header-row">
            <h1>My TODO</h1>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
            >
              {theme === "light" ? "切换深色" : "切换浅色"}
            </button>
          </div>
          <p>今天要完成什么？</p>
        </header>

        <form className="todo-form" onSubmit={handleAddTodo}>
          <div className="form-fields">
            <input
              type="text"
              placeholder="输入任务标题"
              maxLength={120}
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              required
            />
            <textarea
              placeholder="输入描述（可选）"
              maxLength={300}
              rows={3}
              value={descInput}
              onChange={(e) => setDescInput(e.target.value)}
            />
          </div>
          <button type="submit">添加</button>
        </form>

        <section className="toolbar">
          <div className="filter-groups">
            <div className="filters">
              <button type="button" data-active={currentFilter === "all"} onClick={() => setCurrentFilter("all")}>
                全部
              </button>
              <button
                type="button"
                data-active={currentFilter === "active"}
                onClick={() => setCurrentFilter("active")}
              >
                未完成
              </button>
              <button
                type="button"
                data-active={currentFilter === "completed"}
                onClick={() => setCurrentFilter("completed")}
              >
                已完成
              </button>
            </div>

            <div className="date-filter-row">
              <label htmlFor="date-picker-trigger">按日期筛选：</label>
              <div className="custom-date-picker" ref={datePickerRef}>
                <button
                  id="date-picker-trigger"
                  type="button"
                  className="date-trigger"
                  aria-expanded={calendarOpen}
                  onClick={() => setCalendarOpen((prev) => !prev)}
                >
                  <span className="date-picker-icon" aria-hidden="true">
                    DATE
                  </span>
                  <span>{getDateRangeLabel(dateRange)}</span>
                </button>

                {calendarOpen && (
                  <div className="calendar-popover">
                    <div className="calendar-header">
                      <button
                        type="button"
                        className="calendar-nav"
                        aria-label="上个月"
                        onClick={() =>
                          setCalendarViewDate(
                            new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1)
                          )
                        }
                      >
                        ‹
                      </button>
                      <strong>{monthLabel}</strong>
                      <button
                        type="button"
                        className="calendar-nav"
                        aria-label="下个月"
                        onClick={() =>
                          setCalendarViewDate(
                            new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1)
                          )
                        }
                      >
                        ›
                      </button>
                    </div>
                    <div className="calendar-weekdays" aria-hidden="true">
                      <span>日</span>
                      <span>一</span>
                      <span>二</span>
                      <span>三</span>
                      <span>四</span>
                      <span>五</span>
                      <span>六</span>
                    </div>
                    <div className="calendar-grid">
                      {calendarDays.map((day, index) =>
                        day === null ? (
                          <span key={`blank-${index}`} className="calendar-blank" />
                        ) : (
                          <button
                            key={day.dateKey}
                            type="button"
                            className={`calendar-day ${day.selected ? "selected" : ""} ${
                              day.today ? "today" : ""
                            } ${day.rangeStart ? "range-start" : ""} ${day.rangeEnd ? "range-end" : ""} ${
                              day.inRange ? "in-range" : ""
                            }`}
                            onClick={() => {
                              const nextRange = getNextDateRange(dateRange, day.dateKey);
                              setDateRange(nextRange);
                              if (nextRange.start && nextRange.end) {
                                setCalendarOpen(false);
                              }
                            }}
                          >
                            {day.day}
                          </button>
                        )
                      )}
                    </div>
                    <div className="calendar-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => {
                          const today = new Date();
                          const dateKey = toDateKey(today);
                          setDateRange({ start: dateKey, end: dateKey });
                          setCalendarViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
                          setCalendarOpen(false);
                        }}
                      >
                        今天
                      </button>
                      <button type="button" className="secondary-btn" onClick={() => setCalendarOpen(false)}>
                        关闭
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button type="button" className="secondary-btn" onClick={() => setDateRange({ start: "", end: "" })}>
                清空日期
              </button>
            </div>
          </div>

          <button type="button" className="secondary-btn" onClick={handleClearCompleted}>
            清除已完成
          </button>
        </section>

        <ul className="todo-list" aria-live="polite">
          {filteredTodos.length === 0 && <li className="todo-item">暂无任务，先添加一条吧。</li>}

          {filteredTodos.map((todo) => {
            const status = getTodoStatus(todo);
            const parentDraft = parentDescDrafts[todo.id] ?? todo.description;
            const childDraft = childDrafts[todo.id] ?? { text: "", description: "" };
            return (
              <li
                key={todo.id}
                className={`todo-item parent-item status-${status} ${todo.children.length > 0 ? "has-children" : ""} ${
                  todo.collapsed ? "is-collapsed" : ""
                } ${exitingTodoIds.has(todo.id) ? "is-exiting" : ""} ${
                  dragParentId === todo.id ? "is-dragging" : ""
                } ${
                  parentDropHint?.targetId === todo.id ? `drop-${parentDropHint.position}` : ""
                }`}
                ref={(node) => {
                  if (node) itemRefs.current.set(todo.id, node);
                  else itemRefs.current.delete(todo.id);
                }}
                draggable
                onDragStart={() => handleParentDragStart(todo.id)}
                onDragOver={(e) => handleParentDragOver(e, todo.id)}
                onDrop={() => void handleParentDrop(todo.id)}
                onDragEnd={() => {
                  setDragParentId(null);
                  setParentDropHint(null);
                }}
                onClick={(event) => handleParentContainerClick(todo, event)}
              >
                <input
                  type="checkbox"
                  checked={status === "completed"}
                  ref={(node) => {
                    if (node) node.indeterminate = status === "partial";
                  }}
                  onChange={() => void handleToggleParent(todo.id)}
                  aria-label="切换任务完成状态"
                />

                <div className="todo-content">
                  <div className="todo-headline">
                    <span className="todo-title">{todo.text}</span>
                  </div>
                  <p className="todo-time">创建于 {formatTime(todo.createdAt)}</p>
                  {todo.collapsed && todo.children.length > 0 && (
                    <p className="collapsed-meta">
                      子任务 {todo.children.filter((child) => child.completed).length}/{todo.children.length}
                    </p>
                  )}
                  <p className={`todo-desc ${todo.description ? "" : "empty"}`}>
                    {todo.description || "暂无描述"}
                  </p>

                  {editingParentDescFor === todo.id && (
                    <div className="todo-desc-edit-wrap" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        className="parent-desc-editor"
                        rows={3}
                        maxLength={300}
                        value={parentDraft}
                        onChange={(e) =>
                          setParentDescDrafts((prev) => ({ ...prev, [todo.id]: e.target.value }))
                        }
                      />
                      <div className="todo-desc-edit-actions">
                        <button type="button" onClick={() => void handleSaveParentDesc(todo.id)}>
                          保存描述
                        </button>
                        <button type="button" className="secondary-btn" onClick={() => setEditingParentDescFor(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  )}

                  {addingChildFor === todo.id && (
                    <div className="child-create-wrap" onClick={(e) => e.stopPropagation()}>
                      <input
                        className="child-input-title"
                        type="text"
                        maxLength={120}
                        placeholder="子任务标题"
                        value={childDraft.text}
                        onChange={(e) =>
                          setChildDrafts((prev) => ({
                            ...prev,
                            [todo.id]: { ...childDraft, text: e.target.value },
                          }))
                        }
                      />
                      <textarea
                        className="child-input-desc"
                        rows={2}
                        maxLength={300}
                        placeholder="子任务描述（可选）"
                        value={childDraft.description}
                        onChange={(e) =>
                          setChildDrafts((prev) => ({
                            ...prev,
                            [todo.id]: { ...childDraft, description: e.target.value },
                          }))
                        }
                      />
                      <div className="todo-desc-edit-actions">
                        <button type="button" onClick={() => void handleAddChild(todo.id)}>
                          添加子任务
                        </button>
                        <button type="button" className="secondary-btn" onClick={() => setAddingChildFor(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  )}

                  {todo.children.length > 0 && !todo.collapsed && (
                    <ul className="subtodo-list">
                      {todo.children.map((child) => {
                        const childKey = `${todo.id}:${child.id}`;
                        const childDescDraft = childDescDrafts[childKey] ?? child.description;
                        const childEditing = editingChildDescFor === childKey;
                        return (
                          <li
                            key={child.id}
                            className={`subtodo-item ${child.completed ? "completed" : ""} ${
                              dragChild?.parentId === todo.id && dragChild.childId === child.id ? "is-dragging" : ""
                            } ${
                              childDropHint?.parentId === todo.id && childDropHint.targetChildId === child.id
                                ? `drop-${childDropHint.position}`
                                : ""
                            }`}
                            draggable
                            onDragStart={() => handleChildDragStart(todo.id, child.id)}
                            onDragOver={(e) => handleChildDragOver(e, todo.id, child.id)}
                            onDrop={() => void handleChildDrop(todo.id, child.id)}
                            onDragEnd={() => {
                              setDragChild(null);
                              setChildDropHint(null);
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={child.completed}
                              onChange={() => void handleToggleChild(todo.id, child.id)}
                              aria-label="切换子任务完成状态"
                            />
                            <div className="subtodo-content">
                              <span className="todo-title">{child.text}</span>
                              <p className="todo-time">创建于 {formatTime(child.createdAt)}</p>
                              <p className={`todo-desc ${child.description ? "" : "empty"}`}>
                                {child.description || "暂无描述"}
                              </p>

                              {childEditing && (
                                <div className="todo-desc-edit-wrap">
                                  <textarea
                                    className="child-desc-editor"
                                    rows={2}
                                    maxLength={300}
                                    value={childDescDraft}
                                    onChange={(e) =>
                                      setChildDescDrafts((prev) => ({ ...prev, [childKey]: e.target.value }))
                                    }
                                  />
                                  <div className="todo-desc-edit-actions">
                                    <button type="button" onClick={() => void handleSaveChildDesc(todo.id, child.id)}>
                                      保存描述
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() => setEditingChildDescFor(null)}
                                    >
                                      取消
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="todo-actions child-actions">
                              <button
                                type="button"
                                className="todo-edit"
                                onClick={() => {
                                  setEditingChildDescFor(childKey);
                                  setChildDescDrafts((prev) => ({ ...prev, [childKey]: child.description }));
                                }}
                              >
                                编辑描述
                              </button>
                              <button
                                type="button"
                                className="todo-delete"
                                onClick={() => void handleDeleteChild(todo.id, child.id)}
                              >
                                删除
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div className="todo-actions">
                  <button
                    type="button"
                    className="todo-edit"
                    onClick={() => {
                      setAddingChildFor(todo.id);
                      setChildDrafts((prev) => ({
                        ...prev,
                        [todo.id]: prev[todo.id] ?? { text: "", description: "" },
                      }));
                    }}
                  >
                    添加子任务
                  </button>
                  <button
                    type="button"
                    className="todo-edit"
                    onClick={() => {
                      setEditingParentDescFor(todo.id);
                      setParentDescDrafts((prev) => ({ ...prev, [todo.id]: todo.description }));
                    }}
                  >
                    编辑描述
                  </button>
                  <button type="button" className="todo-delete" onClick={() => void handleDeleteParent(todo.id)}>
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <footer className="app-footer">
          <span>{leftCount} 个待完成</span>
        </footer>
      </main>

      {confirmState.open && (
        <div className="confirm-modal">
          <div className="confirm-backdrop" onClick={() => closeConfirmModal(false)} />
          <section className="confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <h3 id="confirm-title">{confirmState.title}</h3>
            <p>{confirmState.message}</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={() => closeConfirmModal(false)}>
                取消
              </button>
              <button type="button" className="todo-delete" onClick={() => closeConfirmModal(true)}>
                {confirmState.confirmText}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );

  function createTodo(text: string, description: string): Todo {
    return {
      id: crypto.randomUUID(),
      text,
      description,
      completed: false,
      createdAt: Date.now(),
      collapsed: false,
      children: [],
    };
  }

  function getTodoStatus(todo: Todo): TodoStatus {
    if (!todo.children || todo.children.length === 0) {
      return todo.completed ? "completed" : "active";
    }
    const total = todo.children.length;
    const done = todo.children.filter((child) => child.completed).length;
    if (done === 0) return "active";
    if (done === total) return "completed";
    return "partial";
  }

  async function loadTodos(): Promise<Todo[]> {
    try {
      const data = await idbGet(TODOS_KEY);
      if (Array.isArray(data)) return normalizeTodos(data as Todo[]);

      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const migrated = JSON.parse(raw) as Todo[];
      if (!Array.isArray(migrated)) return [];
      const normalized = normalizeTodos(migrated);
      await idbSet(TODOS_KEY, normalized);
      localStorage.removeItem(STORAGE_KEY);
      return normalized;
    } catch {
      return loadTodosFromLocal();
    }
  }

  function loadTodosFromLocal(): Todo[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw) as Todo[];
      if (!Array.isArray(data)) return [];
      return normalizeTodos(data);
    } catch {
      return [];
    }
  }

  function normalizeTodos(data: Todo[]): Todo[] {
    return data.map((todo) => {
      const normalizedChildren = Array.isArray(todo.children)
        ? todo.children.map((child) => ({
            id: child.id ?? crypto.randomUUID(),
            text: typeof child.text === "string" ? child.text : "",
            description: typeof child.description === "string" ? child.description : "",
            completed: Boolean(child.completed),
            createdAt: typeof child.createdAt === "number" ? child.createdAt : Date.now(),
          }))
        : [];

      return {
        id: todo.id ?? crypto.randomUUID(),
        text: typeof todo.text === "string" ? todo.text : "",
        description: typeof todo.description === "string" ? todo.description : "",
        completed: Boolean(todo.completed),
        createdAt: typeof todo.createdAt === "number" ? todo.createdAt : Date.now(),
        collapsed: Boolean(todo.collapsed),
        children: normalizedChildren,
      };
    });
  }

  async function saveTodos(nextTodos: Todo[]) {
    try {
      await idbSet(TODOS_KEY, nextTodos);
    } catch {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextTodos));
    }
  }

  function getDB() {
    if (dbPromiseRef.current) return dbPromiseRef.current;
    dbPromiseRef.current = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromiseRef.current;
  }

  async function idbGet(key: string): Promise<unknown> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key: string, value: unknown): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDateKey(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function matchesDateRange(timestamp: number, dateRange: DateRange) {
  if (!dateRange.start) return true;
  const current = toDateKey(new Date(timestamp));
  if (!dateRange.end) return current === dateRange.start;
  return current >= dateRange.start && current <= dateRange.end;
}

function getDateRangeLabel(dateRange: DateRange) {
  if (!dateRange.start) return "选择日期范围";
  if (!dateRange.end) return `${dateRange.start.split("-").join("/")} - 结束日期`;
  return `${dateRange.start.split("-").join("/")} - ${dateRange.end.split("-").join("/")}`;
}

function getNextDateRange(currentRange: DateRange, clickedDate: string): DateRange {
  if (!currentRange.start || currentRange.end) {
    return { start: clickedDate, end: "" };
  }
  if (clickedDate < currentRange.start) {
    return { start: clickedDate, end: currentRange.start };
  }
  if (clickedDate === currentRange.start) {
    return { start: clickedDate, end: clickedDate };
  }
  return { start: currentRange.start, end: clickedDate };
}

function buildCalendarDays(viewDate: Date, dateRange: DateRange) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days: Array<
    | null
    | {
        day: number;
        dateKey: string;
        selected: boolean;
        today: boolean;
        rangeStart: boolean;
        rangeEnd: boolean;
        inRange: boolean;
      }
  > = [];

  for (let i = 0; i < firstDay; i += 1) days.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hasOpenSingle = Boolean(dateRange.start && !dateRange.end && dateKey === dateRange.start);
    const isInRange = Boolean(dateRange.start && dateRange.end && dateKey > dateRange.start && dateKey < dateRange.end);
    days.push({
      day,
      dateKey,
      selected: hasOpenSingle || dateKey === dateRange.start || dateKey === dateRange.end,
      today: dateKey === toDateKey(new Date()),
      rangeStart: dateKey === dateRange.start,
      rangeEnd: dateKey === dateRange.end,
      inRange: isInRange,
    });
  }

  return days;
}

export default App;
