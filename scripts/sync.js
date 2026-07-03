import fs from 'fs';
import path from 'path';
import { MongoClient, ObjectId } from 'mongodb';

// 从环境变量读取配置
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'interviews';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'parser_data';

// 排除的文件夹和文件（在扫描生成大纲时）
const EXCLUDE_DIRS = ['node_modules', '.github', 'scripts', '.git', '.vscode'];
const EXCLUDE_FILES = ['outline.md', 'README.md', 'package.json', 'package-lock.json'];

/**
 * 递归读取目录中的所有 markdown 文件
 */
function getAllMarkdownFiles(dirPath, fileList = []) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const relativePath = path.relative(process.cwd(), fullPath);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(file)) {
        getAllMarkdownFiles(fullPath, fileList);
      }
    } else {
      if (file.endsWith('.md') && !EXCLUDE_FILES.includes(file)) {
        fileList.push(relativePath);
      }
    }
  }
  return fileList;
}

/**
 * 解析 Markdown 文件的 Frontmatter
 */
function parseFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { title: path.basename(filePath, '.md') };

  const yamlText = match[1];
  const metadata = {};
  const lines = yamlText.split('\n');
  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let value = parts.slice(1).join(':').trim();
      // 去掉前后的引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      metadata[key] = value;
    }
  }
  
  // 如果从 Frontmatter 中没有解析到 title，使用文件名作为 title
  if (!metadata.title) {
    metadata.title = path.basename(filePath, '.md');
  }
  return metadata;
}

/**
 * 生成大纲目录并写入 outline.md
 */
function generateOutline() {
  console.log('正在生成大纲目录...');
  const contentsDir = path.join(process.cwd(), 'contents');
  if (!fs.existsSync(contentsDir)) {
    console.log('未找到 contents 目录，跳过大纲生成。');
    return;
  }
  const mdFiles = getAllMarkdownFiles(contentsDir);
  const tree = { files: [], dirs: {} };

  for (const filePath of mdFiles) {
    const metadata = parseFrontmatter(filePath);
    const parts = filePath.split(path.sep);
    const fileName = parts.pop();
    
    // 沿着目录层级构建树
    let current = tree;
    for (const part of parts) {
      if (part === 'contents') continue; // 过滤最外层的 contents 文件夹
      if (!current.dirs[part]) {
        current.dirs[part] = { files: [], dirs: {} };
      }
      current = current.dirs[part];
    }
    current.files.push({
      title: metadata.title,
      path: filePath.replace(/\\/g, '/') // 确保使用正斜杠
    });
  }

  // 深度优先生成 markdown 列表
  let outlineContent = '# 📚 面经知识大纲\n\n> 本文件由同步脚本自动维护，请勿手动修改。\n\n';

  function renderTree(node, depth = 0) {
    const indent = '  '.repeat(depth);
    
    // 先渲染子目录
    const dirKeys = Object.keys(node.dirs).sort();
    for (const dirKey of dirKeys) {
      outlineContent += `${indent}- 📁 **${dirKey}**\n`;
      renderTree(node.dirs[dirKey], depth + 1);
    }
    
    // 再渲染当前目录下的文件
    const sortedFiles = node.files.sort((a, b) => a.title.localeCompare(b.title));
    for (const file of sortedFiles) {
      outlineContent += `${indent}- 📄 [${file.title}](${file.path})\n`;
    }
  }

  renderTree(tree, 0);

  fs.writeFileSync(path.join(process.cwd(), 'outline.md'), outlineContent, 'utf-8');
  console.log('outline.md 大纲生成成功！');
}

/**
 * 主同步逻辑
 */
async function sync() {
  console.log('正在连接 MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('MongoDB 连接成功。');
    
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    const FORCE_SYNC = process.env.FORCE_SYNC === 'true' || process.argv.includes('--force');
    if (FORCE_SYNC) {
      console.log('检测到强制同步参数，将进行全量数据扫描与生成。');
    }
    
    // 查询文档（如果强制同步，则查询所有文档，否则仅查询未同步文档）
    const query = FORCE_SYNC ? {} : {
      $or: [
        { 'metadata.sync_status': { $ne: 'synced' } },
        { 'metadata.sync_status': { $exists: false } }
      ]
    };
    
    const cursor = collection.find(query);
    const documents = await cursor.toArray();
    console.log(`发现 ${documents.length} 条需要同步的文档。`);
    
    if (documents.length === 0) {
      console.log('暂无需要同步的数据。');
      // 依然重新生成一次大纲，防止手动修改后不一致
      generateOutline();
      return;
    }
    
    for (const doc of documents) {
      const { _id, question, raw_questions = [], metadata = {}, content = '' } = doc;
      const categoryPath = metadata.category_path || 'unclassified';
      
      // 创建目标文件夹（统一放到 contents 目录下）
      const targetDir = path.join(process.cwd(), 'contents', categoryPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      
      const fileName = `${_id.toString()}.md`;
      const targetFilePath = path.join(targetDir, fileName);
      
      // 格式化 metadata 值，防止 YAML 语法错误
      const safeTitle = JSON.stringify(question || '');
      const safeLabels = JSON.stringify(metadata.labels || []);
      const safeRaws = JSON.stringify(raw_questions || []);
      const safeCreated = metadata.created_at || new Date().toISOString();
      const safeModified = metadata.updated_at || new Date().toISOString();
      
      // 组装文件内容
      const fileContent = `---
title: ${safeTitle}
labels: ${safeLabels}
raws: ${safeRaws}
status: "synced"
date created: "${safeCreated}"
date modified: "${safeModified}"
---

${content}
`;
      
      // 写入文件
      fs.writeFileSync(targetFilePath, fileContent, 'utf-8');
      console.log(`已写入文件: ${path.relative(process.cwd(), targetFilePath)}`);
      
      // 更新 MongoDB 中的同步状态
      await collection.updateOne(
        { _id: _id },
        {
          $set: {
            'metadata.sync_status': 'synced',
            'metadata.sync_at': new Date().toISOString()
          }
        }
      );
    }
    
    console.log('数据同步完成，准备更新大纲...');
    generateOutline();
    
  } catch (error) {
    console.error('同步过程中发生错误:', error);
    process.exit(1);
  } finally {
    await client.close();
    console.log('MongoDB 连接已关闭。');
  }
}

sync();
