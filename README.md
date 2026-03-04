# NovelReader

轻量桌面小说阅读器（Tauri + Vanilla TS）。

## 开发环境
建议安装：
- Node.js 18+
- Rust stable toolchain
- Visual Studio Build Tools（Windows 打包必需）

## 本地开发
```bash
npm install
npm run tauri dev
```

## 打包教程（Windows）
1. 安装依赖
```bash
npm install
```

2. 执行打包
```bash
npm run tauri build
```

3. 打包产物位置
- `src-tauri/target/release/novel-reader.exe`
- `src-tauri/target/release/bundle/msi/NovelReader_0.1.0_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/NovelReader_0.1.0_x64-setup.exe`

## 发布到 GitHub Release
先推送代码：
```bash
git push -u origin main
```

如果已安装并登录 GitHub CLI，可直接发布：
```bash
gh release create v0.1.0 \
  src-tauri/target/release/bundle/msi/NovelReader_0.1.0_x64_en-US.msi \
  src-tauri/target/release/bundle/nsis/NovelReader_0.1.0_x64-setup.exe \
  --title "NovelReader v0.1.0" \
  --notes "Windows installer release."
```
