const fs = require('fs');
const path = require('path');
const { settingsDir } = require('./settings');

const commandsFile = path.join(settingsDir, 'commands.json');
const defaultCommandsFile = path.join(__dirname, '../../default-commands.json');

function ensureCommandsFile() {
  if (fs.existsSync(commandsFile)) return;
  try {
    const defaultContent = fs.readFileSync(defaultCommandsFile, 'utf-8');
    fs.writeFileSync(commandsFile, defaultContent);
  } catch (err) {
    console.error('[commands] Copy default failed:', err.message, '- creating empty');
    try { fs.writeFileSync(commandsFile, JSON.stringify({ categories: [] }, null, 2)); } catch {}
  }
}

function loadCommands() {
  try {
    ensureCommandsFile();
    const content = fs.readFileSync(commandsFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { categories: [] };
  }
}

function saveCommands(data) {
  try {
    fs.writeFileSync(commandsFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[commands] Write failed:', err.message);
    throw err;
  }
}

function generateId() {
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getCategories() {
  const data = loadCommands();
  return data.categories || [];
}

function addCategory(name, nameEn) {
  const data = loadCommands();
  const category = {
    id: generateId(),
    name,
    nameEn,
    commands: [],
  };
  data.categories.push(category);
  saveCommands(data);
  return category;
}

function updateCategory(id, name, nameEn) {
  const data = loadCommands();
  const category = data.categories.find(c => c.id === id);
  if (!category) throw new Error('Category not found');
  category.name = name;
  category.nameEn = nameEn;
  saveCommands(data);
  return category;
}

function deleteCategory(id) {
  const data = loadCommands();
  const index = data.categories.findIndex(c => c.id === id);
  if (index === -1) throw new Error('Category not found');
  data.categories.splice(index, 1);
  saveCommands(data);
}

function addCommand(categoryId, command, description, descriptionEn) {
  const data = loadCommands();
  const category = data.categories.find(c => c.id === categoryId);
  if (!category) throw new Error('Category not found');
  const cmd = {
    id: generateId(),
    command,
    description,
    descriptionEn,
  };
  category.commands.push(cmd);
  saveCommands(data);
  return cmd;
}

function updateCommand(categoryId, commandId, command, description, descriptionEn) {
  const data = loadCommands();
  const category = data.categories.find(c => c.id === categoryId);
  if (!category) throw new Error('Category not found');
  const cmd = category.commands.find(c => c.id === commandId);
  if (!cmd) throw new Error('Command not found');
  cmd.command = command;
  cmd.description = description;
  cmd.descriptionEn = descriptionEn;
  saveCommands(data);
  return cmd;
}

function deleteCommand(categoryId, commandId) {
  const data = loadCommands();
  const category = data.categories.find(c => c.id === categoryId);
  if (!category) throw new Error('Category not found');
  const index = category.commands.findIndex(c => c.id === commandId);
  if (index === -1) throw new Error('Command not found');
  category.commands.splice(index, 1);
  saveCommands(data);
}

function resetToDefault() {
  const defaultContent = fs.readFileSync(defaultCommandsFile, 'utf-8');
  fs.writeFileSync(commandsFile, defaultContent);
  return JSON.parse(defaultContent);
}

module.exports = {
  loadCommands,
  saveCommands,
  getCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  addCommand,
  updateCommand,
  deleteCommand,
  resetToDefault,
};
