# 使用官方的 Node.js 镜像作为构建阶段基础镜像
FROM node:alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果有的话）
COPY package*.json ./

# 安装项目依赖
RUN npm install

# 复制项目文件到工作目录
COPY server.js index.html ./

# 暴露应用运行的端口
EXPOSE 3000

# 启动应用
CMD ["node", "server.js"]