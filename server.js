const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Create profiles folder if missing
const profilesDir = path.join(__dirname, "profiles");
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir);

app.use(cors());
app.use(bodyParser.json());

// 📨 Upload endpoint
app.post("/upload/:name", (req, res) => {
    const characterName = req.params.name;
    const profileData = req.body;

    const filePath = path.join(profilesDir, `${characterName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(profileData, null, 2));

    res.json({ success: true, message: `Profile saved for ${characterName}` });
});

// 📥 View endpoint
app.get("/view/:name", (req, res) => {
    const characterName = req.params.name;
    const filePath = path.join(profilesDir, `${characterName}.json`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    const profile = fs.readFileSync(filePath, "utf-8");
    res.json(JSON.parse(profile));
});

app.listen(PORT, () => {
    console.log(`✅ Character Select+ RP server running at http://localhost:${PORT}`);
});