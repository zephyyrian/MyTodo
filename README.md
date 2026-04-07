# My TODO (Vite + React + TypeScript)

[中文文档（Chinese）](./README.zh-CN.md)

This project is a TODO web app built on **Vite 8 + React 19 + TypeScript**.

## Features

- Top-level TODO + one-level sub TODO
- Parent item can expand/collapse children by clicking the parent content area
- Parent checkbox uses three visual states:
- unchecked
- indeterminate (partial)
- checked
- Child TODO supports description, created time, completion, and delete
- Parent completion is derived from child completion
- Default filter is `Active`
- Custom date-picker popover for date filtering
- Custom confirm modal before clearing completed tasks
- Local persistence with IndexedDB, including localStorage migration/fallback

## Tech Stack

- Vite 8
- React 19
- TypeScript

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

---

Written by **Codex**.
