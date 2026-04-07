# My TODO（Vite + React + TypeScript）

[English README](./README.md)

这个项目是一个基于 **Vite 8 + React 19 + TypeScript** 的 TODO 网站。

## 功能特性

- 顶级 TODO + 一层子 TODO（子 TODO 不继续嵌套）
- 单击顶级 TODO 内容区域可展开/折叠子任务
- 顶级复选框支持三态显示：
- 未完成（空）
- 半完成（半选）
- 已完成（勾选）
- 子 TODO 支持描述、创建时间、完成状态、删除
- 顶级完成状态由子 TODO 完成情况自动推导
- 默认筛选为“未完成”
- 自定义日期选择器弹层用于日期筛选
- 清除已完成前使用自定义确认弹窗
- 本地存储采用 IndexedDB，并兼容 localStorage 迁移/兜底

## 技术栈

- Vite 8
- React 19
- TypeScript

## 本地运行

```bash
npm install
npm run dev
```

## 构建与预览

```bash
npm run build
npm run preview
```

---

本文档由 **Codex** 编写。
