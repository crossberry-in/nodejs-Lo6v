require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs").promises; // Non-blocking file ops
const fsSync = require("fs");      // Sync ops (startup only)
const path = require("path");

const app = express();

// ---------------------------
// Middleware
// ---------------------------
app.use(cors());
// Increase limits to 50MB for large code blocks
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ---------------------------
// Configuration
// ---------------------------
const MCP_PORT = process.env.MCP_PORT || 4000;
const MCP_API_KEY = process.env.MCP_API_KEY || "v1";

// UPSTREAM CONFIG (Your AI Server)
// Using 127.0.0.1 is safer than localhost to avoid IPv6 errors
const API_SERVER_BASE = process.env.API_SERVER_BASE || "https://nodejs-production-927d.up.railway.app";
const API_SERVER_CHAT_URL = `${API_SERVER_BASE}/api/chat`;
const API_SERVER_MODELS_URL = `${API_SERVER_BASE}/models`;
const API_SERVER_KEY = process.env.API_SERVER_KEY || "surya@369"; // The key for port 3000

// Default Fallback Model
const DEFAULT_MODEL = "gpt-oss:120b"; 

// Safety Limit: ~128k Tokens (approx 450k characters)
const MAX_CONTEXT_CHARS = 450000; 

const THREADS_DIR = path.join(__dirname, "threads");

// Initialize Folder
if (!fsSync.existsSync(THREADS_DIR)) {
  fsSync.mkdirSync(THREADS_DIR, { recursive: true });
}

// ---------------------------
// Helper Functions
// ---------------------------
function safeThreadId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function threadFile(threadId) {
  return path.join(THREADS_DIR, `thread_${safeThreadId(threadId)}.json`);
}

async function loadHistory(threadId) {
  const file = threadFile(threadId);
  try {
    await fs.access(file);
    const data = await fs.readFile(file, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

async function saveHistory(threadId, history) {
  try {
    await fs.writeFile(threadFile(threadId), JSON.stringify(history, null, 2));
  } catch (error) {
    console.error(`❌ Error saving thread:`, error.message);
  }
}

// ---------------------------
// Context Manager (The Infinite Loop Fix)
// ---------------------------
function manageContext(history, newPrompt) {
  let currentChars = newPrompt.length + 1000; // Buffer for system prompt
  let keptHistory = [];

  // Loop BACKWARDS from Newest -> Oldest
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const contentLen = (msg.content || "").length;

    if (currentChars + contentLen < MAX_CONTEXT_CHARS) {
      keptHistory.unshift(msg); // Add to front
      currentChars += contentLen;
    } else {
      console.log(`✂️ Context Full: Dropped message (${contentLen} chars)`);
      // Stop adding once we hit the limit
      break; 
    }
  }
  return keptHistory;
}

// ---------------------------
// Call Upstream AI Server
// ---------------------------
async function callApiServer(prompt, fullHistory, selectedModel) {
  try {
    const safeHistory = manageContext(fullHistory, prompt);
    const modelToUse = selectedModel || DEFAULT_MODEL;

    // 1. Construct Prompt
    const systemInstruction = `System: You are ${modelToUse}, a helpful AI. Answer detailed and accurately. Use Markdown for code.\n\n`;
    
    let conversationText = safeHistory.map(msg => {
      const roleName = msg.role === "user" ? "User" : "AI";
      return `${roleName}: ${msg.content}`;
    }).join("\n");

    if (conversationText) conversationText += "\n";

    const fullPrompt = `${systemInstruction}${conversationText}User: ${prompt}\nAI:`;

    console.log(`\n--- Sending to ${modelToUse} (${fullPrompt.length} chars) ---`);

    // 2. Send Request
    const res = await axios.post(
      API_SERVER_CHAT_URL,
      { 
        prompt: fullPrompt, 
        history: [], // History baked into prompt
        model: modelToUse 
      },
      {
        headers: {
          "Content-Type": "application/json",
          "api-key": API_SERVER_KEY // Pass key to upstream
        },
        timeout: 240000 // 4 minutes
      }
    );

    // 3. Validation
    if (res.data.raw && res.data.raw.error) {
      throw new Error(`Upstream Error: ${res.data.raw.error}`);
    }
    if (!res.data || !res.data.message) {
      throw new Error("Empty response from AI");
    }

    return res.data.message;

  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error("❌ AI API ERROR:", msg);
    if (msg.includes("ECONNREFUSED")) return "Error: AI Server (port 3000) is offline.";
    throw new Error(msg);
  }
}

// ---------------------------
// Route: Get Models (Proxy)
// ---------------------------
app.get("/v1/models", async (req, res) => {
  try {
    // FIX: We must pass the headers here too!
    const response = await axios.get(API_SERVER_MODELS_URL, {
      headers: { "api-key": API_SERVER_KEY }
    });
    
    res.json(response.data);
  } catch (err) {
    console.error("Failed to fetch models:", err.message);
    // Return a safe fallback if upstream fails so UI doesn't break
    res.status(500).json({ error: "Failed to fetch models", details: err.message });
  }
});

// ---------------------------
// Route: Chat (POST)
// ---------------------------
app.post("/v1/chat", async (req, res) => {
  const apiKey = req.headers["api-key"];
  const { thread_id = "default", prompt, model } = req.body;

  if (apiKey !== MCP_API_KEY) return res.status(401).json({ error: "Invalid MCP Key" });
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  try {
    const history = await loadHistory(thread_id);
    const reply = await callApiServer(prompt, history, model);

    history.push({ role: "user", content: prompt });
    history.push({ role: "assistant", content: reply });
    
    // Save without awaiting (faster response)
    saveHistory(thread_id, history);

    res.json({ ok: true, thread_id, reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// Route: History (GET)
// ---------------------------
app.get("/v1/history/:thread_id", async (req, res) => {
  const { thread_id } = req.params;
  try {
    const history = await loadHistory(thread_id);
    res.json({ ok: true, history });
  } catch (err) {
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ---------------------------
// Start Server
// ---------------------------
app.listen(MCP_PORT, () => {
  console.log(`✅ MCP Server running at http://localhost:${MCP_PORT}`);
  console.log(`🔗 Upstream AI: ${API_SERVER_BASE}`);
});
