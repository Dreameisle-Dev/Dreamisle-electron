# 🎵 Dreamisle

> 一个基于 Electron 构建的极简、沉浸式本地音乐播放器。
> 摒弃繁杂的界面，专注于音乐与视觉的流动。

![App Screenshot](./img/img1.png)

## ✨ 特性 (Features)

Dreamisle 旨在提供最纯粹的听觉与视觉体验，特色功能包括：

*   **🎨 沉浸式环境光**：背景随当前播放的音乐封面色调实时流转，营造独特的听歌氛围。
*   **💡 动态封面辉光**：专辑封面拥有根据主色调生成的呼吸感辉光阴影，拒绝死板的黑色投影。
*   **🌫️ 现代毛玻璃 UI**：高级磨砂玻璃质感播放列表，视觉轻盈。
*   **🎛️ 隐形手势控制**：鼠标悬停在封面区域时，**滚动滚轮**即可调节音量，配合极简 HUD 显示。
*   **🌊 液态交互体验**：切歌时文字信息的丝滑下沉/上浮过渡动画，拒绝生硬跳变。
*   **📂 强大的本地解析**：
    *   递归扫描文件夹导入音乐。
    *   支持 MP3, FLAC, WAV, OGG, M4A 格式。
    *   基于 `music-metadata` 的极速内嵌封面与元数据读取。
*   **💾 自动记忆**：记住你的音乐库路径，下次打开即刻播放。

## 🛠️ 技术栈 (Tech Stack)

*   **Core**: Electron (ESM 模式)
*   **Frontend**: JS, CSS
*   **Data Persistence**: `electron-store`
*   **Audio Parsing**: `music-metadata`

## 🚀 快速开始 (Getting Started)

### 1. 克隆项目
```bash
git clone https://github.com/your-username/dreamisle.git
cd dreamisle
```

### 2. 安装依赖
```bash
npm install
```

### 3. 启动应用
```bash
npm start
```

## 🔧 项目结构
```
dreamisle/
├── main.js
├── preload.js
└── renderer/
    ├── index.html
    ├── renderer.js
    └── style/
        └── index.css
```

## 📄 License
MIT
