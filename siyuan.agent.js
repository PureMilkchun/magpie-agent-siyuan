// This module runs in Magpie's moejs sandbox. The Bun entry applies the
// connection to SiYuan through its live settings API.
export const agent = {
  id: "siyuan",
  name: "思源笔记 · SiYuan",
  icon: "data:image/svg+xml;base64,PHN2ZyB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMjQiIGhlaWdodD0iMTAyNCIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCI+Cjx0aXRsZT48L3RpdGxlPgo8ZyBpZD0iaWNvbW9vbi1pZ25vcmUiPgo8L2c+CjxwYXRoIGZpbGw9IiNkMjNmMzEiIGQ9Ik0zNy4wNTIgMzcxLjY3NmwyNjkuODU3LTI2OS44NTd2NTUwLjUwN2wtMjY5Ljg1NyAyNjkuODU3eiI+PC9wYXRoPgo8cGF0aCBmaWxsPSIjM2IzZTQzIiBkPSJNMzA2LjkwOSAxMDEuODE4bDIwNS4wOTEgMjA1LjA5MXY1NTAuNTA3bC0yMDUuMDkxLTIwNS4wOTF6Ij48L3BhdGg+CjxwYXRoIGZpbGw9IiNkMjNmMzEiIGQ9Ik01MTIgMzA2LjkwOWwyMDUuMDkxLTIwNS4wOTF2NTUwLjUwN2wtMjA1LjA5MSAyMDUuMDkxeiI+PC9wYXRoPgo8cGF0aCBmaWxsPSIjM2IzZTQzIiBkPSJNNzE3LjA5MSAxMDEuODE4bDI2OS44NTcgMjY5Ljg1N3Y1NTAuNTA3bC0yNjkuODU3LTI2OS44NTd6Ij48L3BhdGg+Cjwvc3ZnPg==",
  dir: "~/.config/siyuan",
  config: "~/.config/siyuan/magpie/connection.json",
  model: "model",
  notice: "请打开思源笔记，等待模型同步后新建智能体会话。断开时也请保持思源运行，直到原模型恢复。",
}

export function connect({ gateway, model }) {
  return {
    "gateway.url": gateway.v1,
    "gateway.key": gateway.key,
    displayName: model.name || model.id,
    contextLength: model.context || 0,
  }
}
