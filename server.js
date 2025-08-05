const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// 🚀 RAILWAY VOLUME SETUP
// ===============================
// Use mounted volume in production, local directory in development
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : __dirname;
console.log(`📁 Using data directory: ${DATA_DIR}`);

// Create directories if they don't exist
const profilesDir = path.join(DATA_DIR, "profiles");
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

const imagesDir = path.join(DATA_DIR, "public", "images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Create uploads directory within the volume to avoid cross-device issues
const uploadsDir = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Static route to serve uploaded images
app.use("/images", express.static(path.join(DATA_DIR, "public", "images")));

const upload = multer({ dest: uploadsDir });

// Gallery caching
let galleryCache = null;
let galleryCacheTime = 0;
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes cache

app.use(require('compression')());
app.use(cors());
app.use(bodyParser.json());

// Database files - ALL NOW PERSISTENT WITH VOLUMES
const likesDbFile = path.join(DATA_DIR, "likes_database.json");
const friendsDbFile = path.join(DATA_DIR, "friends_database.json");
const announcementsDbFile = path.join(DATA_DIR, "announcements_database.json");
const reportsDbFile = path.join(DATA_DIR, "reports_database.json");
const moderationDbFile = path.join(DATA_DIR, "moderation_database.json");
const activityDbFile = path.join(DATA_DIR, "activity_database.json");
const flaggedDbFile = path.join(DATA_DIR, "flagged_database.json");

// 💾 DATABASE CLASSES
class LikesDatabase {
    constructor() {
        this.likes = new Map();
        this.likeCounts = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(likesDbFile)) {
                const data = JSON.parse(fs.readFileSync(likesDbFile, 'utf-8'));
                this.likes = new Map(data.likes.map(([k, v]) => [k, new Set(v)]));
                this.likeCounts = new Map(data.likeCounts);
                console.log(`💾 Loaded ${this.likeCounts.size} like records`);
            }
        } catch (err) {
            console.error('Error loading likes database:', err);
            this.likes = new Map();
            this.likeCounts = new Map();
        }
    }

    save() {
        try {
            const data = {
                likes: Array.from(this.likes.entries()).map(([k, v]) => [k, Array.from(v)]),
                likeCounts: Array.from(this.likeCounts.entries()),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = likesDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(likesDbFile)) {
                fs.copyFileSync(likesDbFile, likesDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, likesDbFile);
        } catch (err) {
            console.error('Error saving likes database:', err);
        }
    }

    addLike(characterId, likerId) {
        if (!this.likes.has(characterId)) {
            this.likes.set(characterId, new Set());
        }
        
        const wasNew = !this.likes.get(characterId).has(likerId);
        if (wasNew) {
            this.likes.get(characterId).add(likerId);
            this.likeCounts.set(characterId, (this.likeCounts.get(characterId) || 0) + 1);
            this.save();
        }
        return this.likeCounts.get(characterId) || 0;
    }

    removeLike(characterId, likerId) {
        if (this.likes.has(characterId)) {
            const wasRemoved = this.likes.get(characterId).delete(likerId);
            if (wasRemoved) {
                const newCount = Math.max(0, (this.likeCounts.get(characterId) || 0) - 1);
                this.likeCounts.set(characterId, newCount);
                this.save();
                return newCount;
            }
        }
        return this.likeCounts.get(characterId) || 0;
    }

    getLikeCount(characterId) {
        return this.likeCounts.get(characterId) || 0;
    }
}

class FriendsDatabase {
    constructor() {
        this.friends = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(friendsDbFile)) {
                const data = JSON.parse(fs.readFileSync(friendsDbFile, 'utf-8'));
                this.friends = new Map(data.friends.map(([k, v]) => [k, new Set(v)]));
                console.log(`🤝 Loaded ${this.friends.size} friend records`);
            }
        } catch (err) {
            console.error('Error loading friends database:', err);
            this.friends = new Map();
        }
    }

    save() {
        try {
            const data = {
                friends: Array.from(this.friends.entries()).map(([k, v]) => [k, Array.from(v)]),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = friendsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(friendsDbFile)) {
                fs.copyFileSync(friendsDbFile, friendsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, friendsDbFile);
        } catch (err) {
            console.error('Error saving friends database:', err);
        }
    }

    updateFriends(characterId, friendsList) {
        this.friends.set(characterId, new Set(friendsList));
        this.save();
    }

    getFriends(characterId) {
        return Array.from(this.friends.get(characterId) || []);
    }

    getMutualFriends(characterId) {
        const myFriends = this.friends.get(characterId) || new Set();
        const mutuals = [];
        
        for (const friendId of myFriends) {
            const theirFriends = this.friends.get(friendId) || new Set();
            if (theirFriends.has(characterId)) {
                mutuals.push(friendId);
            }
        }
        
        return mutuals;
    }
}

class AnnouncementsDatabase {
    constructor() {
        this.announcements = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(announcementsDbFile)) {
                const data = JSON.parse(fs.readFileSync(announcementsDbFile, 'utf-8'));
                this.announcements = data.announcements || [];
                console.log(`📢 Loaded ${this.announcements.length} announcements`);
            }
        } catch (err) {
            console.error('Error loading announcements database:', err);
            this.announcements = [];
        }
    }

    save() {
        try {
            const data = {
                announcements: this.announcements,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = announcementsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(announcementsDbFile)) {
                fs.copyFileSync(announcementsDbFile, announcementsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, announcementsDbFile);
        } catch (err) {
            console.error('Error saving announcements database:', err);
        }
    }

    addAnnouncement(title, message, type = 'info') {
        const announcement = {
            id: crypto.randomUUID(),
            title,
            message,
            type,
            createdAt: new Date().toISOString(),
            active: true
        };
        
        this.announcements.unshift(announcement);
        this.save();
        console.log(`📢 Added announcement: ${title}`);
        return announcement;
    }

    getActiveAnnouncements() {
        return this.announcements.filter(a => a.active);
    }

    getAllAnnouncements() {
        return this.announcements;
    }

    deactivateAnnouncement(id) {
        const announcement = this.announcements.find(a => a.id === id);
        if (announcement) {
            announcement.active = false;
            this.save();
            return true;
        }
        return false;
    }

    deleteAnnouncement(id) {
        const index = this.announcements.findIndex(a => a.id === id);
        if (index !== -1) {
            this.announcements.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
}

class ReportsDatabase {
    constructor() {
        this.reports = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(reportsDbFile)) {
                const data = JSON.parse(fs.readFileSync(reportsDbFile, 'utf-8'));
                this.reports = data.reports || [];
                console.log(`🚨 Loaded ${this.reports.length} reports`);
            }
        } catch (err) {
            console.error('Error loading reports database:', err);
            this.reports = [];
        }
    }

    save() {
        try {
            const data = {
                reports: this.reports,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = reportsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(reportsDbFile)) {
                fs.copyFileSync(reportsDbFile, reportsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, reportsDbFile);
        } catch (err) {
            console.error('Error saving reports database:', err);
        }
    }

    addReport(reportedCharacterId, reportedCharacterName, reporterCharacter, reason, details) {
        const report = {
            id: crypto.randomUUID(),
            reportedCharacterId,
            reportedCharacterName,
            reporterCharacter,
            reason,
            details,
            status: 'pending',
            createdAt: new Date().toISOString(),
            reviewedAt: null,
            reviewedBy: null,
            adminNotes: null
        };
        
        this.reports.unshift(report);
        this.save();
        console.log(`🚨 New report: ${reportedCharacterName} reported for ${reason}`);
        return report;
    }

    getReports(status = null) {
        if (status) {
            return this.reports.filter(r => r.status === status);
        }
        return this.reports;
    }

    updateReportStatus(reportId, status, adminNotes = null, adminId = 'admin') {
        const report = this.reports.find(r => r.id === reportId);
        if (report) {
            report.status = status;
            report.reviewedAt = new Date().toISOString();
            report.reviewedBy = adminId;
            report.adminNotes = adminNotes;
            this.save();
            return true;
        }
        return false;
    }
}

class ModerationDatabase {
    constructor() {
        this.actions = [];
        this.bannedProfiles = new Set();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(moderationDbFile)) {
                const data = JSON.parse(fs.readFileSync(moderationDbFile, 'utf-8'));
                this.actions = data.actions || [];
                this.bannedProfiles = new Set(data.bannedProfiles || []);
                console.log(`🛡️ Loaded ${this.actions.length} moderation actions, ${this.bannedProfiles.size} banned profiles`);
            }
        } catch (err) {
            console.error('Error loading moderation database:', err);
            this.actions = [];
            this.bannedProfiles = new Set();
        }
    }

    save() {
        try {
            const data = {
                actions: this.actions,
                bannedProfiles: Array.from(this.bannedProfiles),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = moderationDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(moderationDbFile)) {
                fs.copyFileSync(moderationDbFile, moderationDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, moderationDbFile);
        } catch (err) {
            console.error('Error saving moderation database:', err);
        }
    }

    logAction(action, characterId, characterName, reason, adminId) {
        const moderationAction = {
            id: crypto.randomUUID(),
            action,
            characterId,
            characterName,
            reason,
            adminId,
            timestamp: new Date().toISOString()
        };
        
        this.actions.unshift(moderationAction);
        this.save();
        console.log(`🛡️ Moderation: ${action} on ${characterName} by ${adminId}`);
        
        // Log to activity feed
        activityDB.logActivity('moderation', `${action.toUpperCase()}: ${characterName}`, {
            action,
            characterId,
            characterName,
            adminId,
            reason
        });
        
        return moderationAction;
    }

    banProfile(characterId) {
        this.bannedProfiles.add(characterId);
        this.save();
    }

    unbanProfile(characterId) {
        this.bannedProfiles.delete(characterId);
        this.save();
    }

    isProfileBanned(characterId) {
        return this.bannedProfiles.has(characterId);
    }

    getActions() {
        return this.actions;
    }
}

class ActivityDatabase {
    constructor() {
        this.activities = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(activityDbFile)) {
                const data = JSON.parse(fs.readFileSync(activityDbFile, 'utf-8'));
                this.activities = data.activities || [];
                console.log(`📊 Loaded ${this.activities.length} activity entries`);
            }
        } catch (err) {
            console.error('Error loading activity database:', err);
            this.activities = [];
        }
    }

    save() {
        try {
            const data = {
                activities: this.activities.slice(0, 1000), // Keep only latest 1000 entries
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = activityDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(activityDbFile)) {
                fs.copyFileSync(activityDbFile, activityDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, activityDbFile);
        } catch (err) {
            console.error('Error saving activity database:', err);
        }
    }

    logActivity(type, message, metadata = {}) {
        const activity = {
            id: crypto.randomUUID(),
            type, // 'upload', 'like', 'report', 'moderation', 'flag'
            message,
            metadata,
            timestamp: new Date().toISOString()
        };
        
        this.activities.unshift(activity);
        
        // Keep only latest 1000 activities
        if (this.activities.length > 1000) {
            this.activities = this.activities.slice(0, 1000);
        }
        
        this.save();
        return activity;
    }

    getActivities(limit = 50) {
        return this.activities.slice(0, limit);
    }

    getActivitiesByType(type, limit = 50) {
        return this.activities.filter(a => a.type === type).slice(0, limit);
    }
}

class AutoFlaggingDatabase {
    constructor() {
        this.flaggedProfiles = [];
        this.flaggedKeywords = [
            // Racism
            'white power', 'racial purity', 'master race', 'white supremacy',
            // Transphobia  
            'tr*nny', 'tr@nny', 'tranny', 'tr4nny', '41%', 'attack helicopter',
            'real women', 'biological women', 'men in dresses',
            // Homophobia
            'f*ggot', 'f@ggot', 'faggot', 'f4ggot',
            // General hate
            'kill yourself', 'kys', 'rope yourself', 'gas the',
            // Slurs (partial list)
            'n*gger', 'n@gger', 'nigger', 'n1gger'
        ];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(flaggedDbFile)) {
                const data = JSON.parse(fs.readFileSync(flaggedDbFile, 'utf-8'));
                this.flaggedProfiles = data.flaggedProfiles || [];
                this.flaggedKeywords = data.flaggedKeywords || this.flaggedKeywords;
                console.log(`🚩 Loaded ${this.flaggedProfiles.length} flagged profiles`);
            }
        } catch (err) {
            console.error('Error loading flagging database:', err);
            this.flaggedProfiles = [];
        }
    }

    save() {
        try {
            const data = {
                flaggedProfiles: this.flaggedProfiles,
                flaggedKeywords: this.flaggedKeywords,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = flaggedDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(flaggedDbFile)) {
                fs.copyFileSync(flaggedDbFile, flaggedDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, flaggedDbFile);
        } catch (err) {
            console.error('Error saving flagging database:', err);
        }
    }

    scanProfile(characterId, characterName, bio, galleryStatus, tags) {
        const content = `${bio || ''} ${galleryStatus || ''} ${tags || ''}`.toLowerCase();
        const flaggedKeywords = [];
        
        for (const keyword of this.flaggedKeywords) {
            if (content.includes(keyword.toLowerCase())) {
                flaggedKeywords.push(keyword);
            }
        }
        
        if (flaggedKeywords.length > 0) {
            const flag = {
                id: crypto.randomUUID(),
                characterId,
                characterName,
                content: content.substring(0, 500), // Store first 500 chars for review
                flaggedKeywords,
                status: 'pending',
                flaggedAt: new Date().toISOString(),
                reviewedAt: null,
                reviewedBy: null
            };
            
            this.flaggedProfiles.unshift(flag);
            this.save();
            
            console.log(`🚩 Auto-flagged profile: ${characterName} for keywords: ${flaggedKeywords.join(', ')}`);
            
            // Log to activity feed
            activityDB.logActivity('flag', `AUTO-FLAGGED: ${characterName}`, {
                characterId,
                characterName,
                keywords: flaggedKeywords
            });
            
            return flag;
        }
        
        return null;
    }

    getFlaggedProfiles(status = null) {
        if (status) {
            return this.flaggedProfiles.filter(f => f.status === status);
        }
        return this.flaggedProfiles;
    }

    updateFlagStatus(flagId, status, reviewedBy) {
        const flag = this.flaggedProfiles.find(f => f.id === flagId);
        if (flag) {
            flag.status = status;
            flag.reviewedAt = new Date().toISOString();
            flag.reviewedBy = reviewedBy;
            this.save();
            
            // Log to activity feed
            activityDB.logActivity('moderation', `FLAG ${status.toUpperCase()}: ${flag.characterName}`, {
                flagId,
                characterName: flag.characterName,
                reviewedBy
            });
            
            return true;
        }
        return false;
    }

    addKeyword(keyword) {
        if (!this.flaggedKeywords.includes(keyword.toLowerCase())) {
            this.flaggedKeywords.push(keyword.toLowerCase());
            this.save();
            return true;
        }
        return false;
    }

    removeKeyword(keyword) {
        const index = this.flaggedKeywords.indexOf(keyword.toLowerCase());
        if (index !== -1) {
            this.flaggedKeywords.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
}

// Initialize databases
const likesDB = new LikesDatabase();
const friendsDB = new FriendsDatabase();
const announcementsDB = new AnnouncementsDatabase();
const reportsDB = new ReportsDatabase();
const moderationDB = new ModerationDatabase();
const activityDB = new ActivityDatabase();
const autoFlagDB = new AutoFlaggingDatabase();

// Admin authentication middleware
function requireAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    // FIXED: Get admin ID from header, fallback to 'unknown'
    req.adminId = req.headers['x-admin-id'] || req.body.adminId || 'unknown_admin';
    console.log(`🛡️ Admin authenticated: ${req.adminId}`);
    next();
}

// Helper functions (keeping all the existing ones)

// Safe file move function that handles cross-device moves
async function safeFileMove(sourcePath, destPath) {
    try {
        // Try rename first (fastest)
        await new Promise((resolve, reject) => {
            fs.rename(sourcePath, destPath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } catch (err) {
        if (err.code === 'EXDEV') {
            // Cross-device link error, fall back to copy + delete
            console.log('Cross-device move detected, using copy + delete');
            await new Promise((resolve, reject) => {
                fs.copyFile(sourcePath, destPath, (copyErr) => {
                    if (copyErr) {
                        reject(copyErr);
                        return;
                    }
                    fs.unlink(sourcePath, (unlinkErr) => {
                        if (unlinkErr) console.warn('Failed to delete temp file:', unlinkErr);
                        resolve();
                    });
                });
            });
        } else {
            throw err;
        }
    }
}

async function cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName) {
    try {
        const allFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json') &&
                    file !== `${newFileName}.json`
                ));
            });
        });

        const oldVersions = [];
        
        for (const file of allFiles) {
            if (file.endsWith(`_${physicalCharacterName}.json`)) {
                try {
                    const filePath = path.join(profilesDir, file);
                    const oldProfile = await readProfileAsync(filePath);
                    
                    if (oldProfile.CharacterName === csCharacterName) {
                        oldVersions.push({ file, path: filePath });
                    }
                } catch (err) {
                    continue;
                }
            }
        }

        for (const oldVersion of oldVersions) {
            fs.unlinkSync(oldVersion.path);
        }
        
        if (oldVersions.length > 0) {
            galleryCache = null;
        }
    } catch (cleanupErr) {
        console.error('Error during cleanup:', cleanupErr.message);
    }
}

async function atomicWriteProfile(filePath, profile) {
    const tempPath = filePath + '.tmp';
    const backupPath = filePath + '.backup';
    
    try {
        // Create backup if original exists
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, backupPath);
        }
        
        // Write directly using synchronous method to avoid temp file conflicts
        const jsonString = JSON.stringify(profile, null, 2);
        fs.writeFileSync(tempPath, jsonString, 'utf-8');
        
        // Atomic rename
        fs.renameSync(tempPath, filePath);
        
    } catch (error) {
        // Clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (cleanupErr) {
                console.warn('Failed to cleanup temp file:', cleanupErr);
            }
        }
        throw error;
    }
}

function sanitizeGalleryData(profiles) {
    return profiles.map(profile => ({
        CharacterId: generateSafeId(profile.CharacterName, profile.CharacterId),
        CharacterName: profile.CharacterName,
        Server: "Gallery",
        ProfileImageUrl: null,
        Tags: profile.Tags,
        Bio: profile.Bio,
        GalleryStatus: profile.GalleryStatus,
        Race: profile.Race,
        Pronouns: profile.Pronouns,
        Links: profile.Links,
        LikeCount: profile.LikeCount,
        LastUpdated: profile.LastUpdated,
        ImageZoom: profile.ImageZoom,
        ImageOffset: profile.ImageOffset,
        IsNSFW: profile.IsNSFW || false // Include NSFW flag for client filtering
    }));
}

function sanitizeProfileResponse(profile) {
    const sanitized = { ...profile };
    delete sanitized.CustomImagePath;
    return sanitized;
}

function generateSafeId(characterName, originalId) {
    return characterName.toLowerCase().replace(/\s+/g, '_') + '_' + 
           crypto.createHash('md5').update(originalId).digest('hex').substring(0, 8);
}

const readProfileAsync = (filePath) => {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf-8', (err, data) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!data || data.trim().length === 0) {
                reject(new Error(`Profile file is empty: ${filePath}`));
                return;
            }
            
            try {
                const parsed = JSON.parse(data);
                resolve(parsed);
            } catch (parseError) {
                console.error(`[Error] Invalid JSON in file ${filePath}:`, parseError.message);
                fs.unlink(filePath, (unlinkErr) => {
                    if (!unlinkErr) {
                        console.log(`[Recovery] Deleted corrupted file: ${filePath}`);
                    }
                });
                reject(new Error(`Invalid JSON in profile file: ${filePath}`));
            }
        });
    });
};

const writeProfileAsync = (filePath, data) => {
    return new Promise((resolve, reject) => {
        let jsonString;
        try {
            jsonString = JSON.stringify(data, null, 2);
        } catch (stringifyError) {
            reject(stringifyError);
            return;
        }
        
        if (filePath.includes(' ')) {
            fs.writeFile(filePath, jsonString, 'utf-8', (writeErr) => {
                if (writeErr) reject(writeErr);
                else resolve();
            });
            return;
        }
        
        const tempPath = filePath + '.tmp';
        
        fs.writeFile(tempPath, jsonString, 'utf-8', (writeErr) => {
            if (writeErr) {
                reject(writeErr);
                return;
            }
            
            fs.rename(tempPath, filePath, (renameErr) => {
                if (renameErr) {
                    fs.unlink(tempPath, () => {});
                    reject(renameErr);
                    return;
                }
                resolve();
            });
        });
    });
};

const isValidProfile = (profile) => {
    return profile && 
           typeof profile === 'object' && 
           typeof profile.CharacterName === 'string' &&
           profile.CharacterName.length > 0;
};

function extractServerFromName(characterName) {
    const parts = characterName.split('@');
    return parts.length > 1 ? parts[1] : 'Unknown';
}

// =============================================================================
// 🖥️ ADMIN DASHBOARD - IMPROVED VERSION WITH PHASE 1 FIXES
// =============================================================================

app.get("/admin", (req, res) => {
    const adminHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Character Select+ Admin Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
            min-height: 100vh;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 20px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            backdrop-filter: blur(10px);
        }
        
        .auth-section {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        
        .tabs {
            display: flex;
            margin-bottom: 20px;
            border-bottom: 2px solid rgba(255, 255, 255, 0.2);
        }
        
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: #ccc;
            transition: all 0.3s;
        }
        
        .tab.active {
            color: #4CAF50;
            border-bottom: 2px solid #4CAF50;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .profile-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        
        .profile-card {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            height: 240px;
            display: flex;
            flex-direction: column;
        }
        
        .profile-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 10px;
        }
        
        .profile-info {
            flex: 1;
        }
        
        .profile-image {
            width: 60px;
            height: 60px;
            border-radius: 8px;
            object-fit: cover;
            margin-left: 15px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            cursor: pointer;
            transition: all 0.3s;
        }
        
        .profile-image:hover {
            border-color: #4CAF50;
            transform: scale(1.05);
        }
        
        .profile-image-placeholder {
            width: 60px;
            height: 60px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.1);
            margin-left: 15px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: #666;
        }
        
        .profile-name {
            font-weight: bold;
            color: #4CAF50;
            font-size: 0.95em;
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        
        .nsfw-badge {
            background: rgba(255, 87, 34, 0.2);
            color: #ff5722;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 0.7em;
            border: 1px solid #ff5722;
            white-space: nowrap;
        }
        
        .profile-id {
            color: #aaa;
            font-size: 0.8em;
            margin-top: 2px;
            font-family: monospace;
        }
        
        .profile-content {
            margin: 10px 0;
            font-size: 0.9em;
            color: #ddd;
            flex: 1;
            overflow-y: auto;
            max-height: 80px;
            padding-right: 5px;
        }
        
        .profile-content::-webkit-scrollbar {
            width: 4px;
        }
        
        .profile-content::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
        }
        
        .profile-content::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 2px;
        }
        
        .profile-content::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.5);
        }
        
        .gallery-status {
            font-style: italic;
            color: #ddd;
            margin: 4px 0;
            font-size: 0.9em;
        }
        
        .gallery-status:before {
            content: '"';
            color: #4CAF50;
        }
        
        .gallery-status:after {
            content: '"';
            color: #4CAF50;
        }
        
        .profile-actions {
            display: flex;
            gap: 6px;
            margin-top: auto;
            flex-wrap: wrap;
        }
        
        .profile-actions .btn {
            font-size: 0.75em;
            padding: 6px 8px;
            flex: 1;
            min-width: 60px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .btn-nsfw {
            background: #ff5722;
            color: white;
            font-size: 0.75em;
            padding: 6px 8px;
        }
        
        .btn-nsfw:hover {
            background: #d84315;
        }
        
        .btn-nsfw.active {
            background: #d84315;
            box-shadow: 0 0 0 2px rgba(255, 87, 34, 0.3);
        }
        
        /* Image Modal Styles */
        .image-modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.9);
            cursor: pointer;
        }
        
        .image-modal-content {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            max-width: 90%;
            max-height: 90%;
            border-radius: 10px;
        }
        
        .image-modal-close {
            position: absolute;
            top: 15px;
            right: 35px;
            color: #f1f1f1;
            font-size: 40px;
            font-weight: bold;
            cursor: pointer;
        }
        
        .image-modal-close:hover {
            color: #4CAF50;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 0.9em;
            transition: all 0.3s;
        }
        
        .btn-danger {
            background: #f44336;
            color: white;
        }
        
        .btn-danger:hover {
            background: #d32f2f;
        }
        
        .btn-warning {
            background: #ff9800;
            color: white;
        }
        
        .btn-warning:hover {
            background: #f57c00;
        }
        
        .btn-secondary {
            background: #6c757d;
            color: white;
        }
        
        .btn-secondary:hover {
            background: #5a6268;
        }
        
        .btn-primary {
            background: #2196F3;
            color: white;
        }
        
        .btn-primary:hover {
            background: #1976D2;
        }
        
        .input-group {
            margin-bottom: 15px;
        }
        
        .input-group label {
            display: block;
            margin-bottom: 5px;
            color: #ccc;
        }
        
        .input-group input, .input-group textarea, .input-group select {
            width: 100%;
            padding: 10px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 5px;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        
        .input-group select {
            background: rgba(255, 255, 255, 0.15);
            color: #fff;
        }
        
        .input-group select option {
            background: #2c2c54;
            color: #fff;
            padding: 8px;
        }
        
        .input-group select option:hover {
            background: #4CAF50;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        
        .stat-number {
            font-size: 2em;
            font-weight: bold;
            color: #4CAF50;
        }
        
        .loading {
            text-align: center;
            padding: 20px;
            color: #ccc;
        }
        
        .error {
            background: rgba(244, 67, 54, 0.2);
            border: 1px solid #f44336;
            color: #f44336;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
        }
        
        .success {
            background: rgba(76, 175, 80, 0.2);
            border: 1px solid #4CAF50;
            color: #4CAF50;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
        }
        
        .report-card {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #ff9800;
            display: flex;
            gap: 15px;
        }
        
        .report-card.reason-spam {
            border-left-color: #ff5722;
        }
        
        .report-card.reason-inappropriate {
            border-left-color: #f44336;
        }
        
        .report-card.reason-malicious {
            border-left-color: #e91e63;
        }
        
        .report-card.reason-harassment {
            border-left-color: #9c27b0;
        }
        
        .report-card.reason-other {
            border-left-color: #ff9800;
        }
        
        .report-info {
            flex: 1;
        }
        
        .reported-profile {
            width: 140px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 10px;
            text-align: center;
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
        }
        
        .reported-profile-image {
            width: 80px;
            height: 80px;
            border-radius: 8px;
            object-fit: cover;
            margin: 0 auto 8px auto;
            border: 2px solid rgba(255, 255, 255, 0.3);
            cursor: pointer;
            transition: all 0.3s;
            display: block;
        }
        
        .reported-profile-image:hover {
            border-color: #4CAF50;
            transform: scale(1.05);
        }
        
        .reported-profile-placeholder {
            width: 80px;
            height: 80px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.1);
            margin: 0 auto 8px auto;
            border: 2px solid rgba(255, 255, 255, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: #666;
        }
        
        .reported-profile-name {
            font-size: 0.9em;
            color: #4CAF50;
            font-weight: bold;
            margin-bottom: 4px;
            word-break: break-word;
        }
        
        .reported-profile-server {
            font-size: 0.8em;
            color: #aaa;
            margin-bottom: 8px;
        }
        
        .reported-profile-actions {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: auto;
        }
        
        .reported-profile-actions .btn {
            font-size: 0.7em;
            padding: 4px 6px;
        }
        
        .reason-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: bold;
            margin-bottom: 8px;
            background: rgba(255, 255, 255, 0.1);
            color: #ddd;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .report-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .announcement-card {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #2196F3;
        }
        
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
            margin: 20px 0;
            padding: 20px;
        }
        
        .pagination button {
            padding: 8px 12px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border-radius: 5px;
            cursor: pointer;
            transition: all 0.3s;
        }
        
        .pagination button:hover:not(:disabled) {
            background: rgba(76, 175, 80, 0.3);
            border-color: #4CAF50;
        }
        
        .pagination button.active {
            background: #4CAF50;
            border-color: #4CAF50;
        }
        
        .pagination button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .pagination-info {
            color: #ccc;
            font-size: 0.9em;
        }
        
        /* Activity Feed Styles */
        .activity-item {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 10px;
            border-left: 4px solid #4CAF50;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .activity-item.upload {
            border-left-color: #2196F3;
        }
        
        .activity-item.like {
            border-left-color: #ff5722;
        }
        
        .activity-item.report {
            border-left-color: #ff9800;
        }
        
        .activity-item.moderation {
            border-left-color: #9c27b0;
        }
        
        .activity-item.flag {
            border-left-color: #f44336;
        }
        
        .activity-content {
            flex: 1;
        }
        
        .activity-message {
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .activity-metadata {
            font-size: 0.85em;
            color: #aaa;
        }
        
        .activity-time {
            font-size: 0.8em;
            color: #666;
            white-space: nowrap;
            margin-left: 15px;
        }
        
        /* Advanced Filtering Styles */
        .filter-section {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .filter-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 15px;
        }
        
        .filter-row {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .filter-controls {
            display: flex;
            gap: 10px;
            justify-content: center;
        }
        
        .filter-active {
            background: rgba(76, 175, 80, 0.2);
            border-color: #4CAF50;
        }
        
        /* Flagged Content Styles */
        .flagged-card {
            background: rgba(244, 67, 54, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #f44336;
        }
        
        .flagged-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .flagged-keywords {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.85em;
            font-family: monospace;
            margin: 5px 5px 5px 0;
            display: inline-block;
        }
        
        .flagged-content {
            background: rgba(0, 0, 0, 0.3);
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
            font-family: monospace;
            font-size: 0.9em;
            max-height: 100px;
            overflow-y: auto;
        }
        
        /* Bulk selection styles */
        .profile-checkbox {
            display: block;
            width: 18px;
            height: 18px;
            margin: 10px auto 0 auto;
            cursor: pointer;
        }
        
        .profile-card {
            position: relative;
        }
        
        .profile-card.selected {
            border: 2px solid #4CAF50;
            box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
        }
        
        .select-all-container {
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 15px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .select-all-checkbox {
            width: 18px;
            height: 18px;
            cursor: pointer;
        }
        
        .select-all-label {
            color: #ccc;
            font-size: 0.9em;
            cursor: pointer;
        }
        
        .bulk-action-bar {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(30, 30, 54, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            padding: 15px 25px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            border: 1px solid rgba(255, 255, 255, 0.2);
            display: none;
            align-items: center;
            gap: 15px;
            z-index: 1000;
            min-width: 400px;
        }
        
        .bulk-action-bar.show {
            display: flex;
        }
        
        .bulk-selection-count {
            color: #4CAF50;
            font-weight: bold;
            margin-right: 10px;
        }
        
        .bulk-actions {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        
        .bulk-actions input[type="text"] {
            padding: 8px 12px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            font-size: 0.9em;
            width: 200px;
        }
        
        .bulk-actions input[type="text"]::placeholder {
            color: rgba(255, 255, 255, 0.6);
        }
        
        /* Modal styles */
        .modal {
            display: none;
            position: fixed;
            z-index: 2000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(5px);
        }
        
        .modal.show {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .modal-content {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 12px;
            padding: 25px;
            max-width: 500px;
            width: 90%;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }
        
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            padding-bottom: 15px;
        }
        
        .modal-title {
            color: #fff;
            font-size: 1.2em;
            font-weight: bold;
        }
        
        .modal-close {
            background: none;
            border: none;
            color: #ccc;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 30px;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .modal-close:hover {
            color: #fff;
        }
        
        .modal-body {
            margin-bottom: 20px;
            color: #ccc;
            line-height: 1.5;
        }
        
        .modal-body .profile-info {
            background: rgba(255, 255, 255, 0.05);
            padding: 10px;
            border-radius: 6px;
            margin: 10px 0;
        }
        
        .modal-footer {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        
        .modal-footer .btn {
            min-width: 80px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛡️ Character Select+ Admin Dashboard</h1>
            <p>Manage gallery, announcements, and reports</p>
        </div>
        
        <div class="auth-section">
            <div class="input-group">
                <label for="adminKey">Admin Secret Key:</label>
                <input type="password" id="adminKey" placeholder="Enter your admin secret key">
            </div>
            <div class="input-group">
                <label for="adminName">Your Admin Name:</label>
                <input type="text" id="adminName" placeholder="Your name (for moderation logs)" value="">
            </div>
            <button class="btn btn-primary" onclick="loadDashboard()">Load Dashboard</button>
        </div>
        
        <div id="dashboardContent" style="display: none;">
            <div class="stats" id="statsSection">
                <div class="stat-card">
                    <div class="stat-number" id="totalProfiles">-</div>
                    <div>Gallery Profiles</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="pendingReports">-</div>
                    <div>Pending Reports</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="totalBanned">-</div>
                    <div>Banned Profiles</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="activeAnnouncements">-</div>
                    <div>Active Announcements</div>
                </div>
            </div>
            
            <div style="text-align: center; margin-bottom: 20px;">
                <button class="btn btn-primary" onclick="refreshStats()" id="refreshBtn">
                    🔄 Refresh All
                </button>
            </div>
            
            <div class="tabs">
                <button class="tab active" onclick="showTab('profiles')">Gallery Profiles</button>
                <button class="tab" onclick="showTab('activity')">Activity Feed</button>
                <button class="tab" onclick="showTab('flagged')">Auto-Flagged</button>
                <button class="tab" onclick="showTab('announcements')">Announcements</button>
                <button class="tab" onclick="showTab('reports')">Pending Reports</button>
                <button class="tab" onclick="showTab('archived')">Archived Reports</button>
                <button class="tab" onclick="showTab('banned')">Banned Profiles</button>
                <button class="tab" onclick="showTab('moderation')">Moderation Log</button>
            </div>
            
            <div id="profiles" class="tab-content active">
                <h3>Gallery Profiles</h3>
                
                <!-- Bulk Selection Controls -->
                <div class="select-all-container">
                    <input type="checkbox" id="selectAllCheckbox" class="select-all-checkbox" onchange="toggleSelectAll()">
                    <label for="selectAllCheckbox" class="select-all-label">Select All Visible</label>
                </div>
                
                <!-- Advanced Filtering Section -->
                <div class="filter-section">
                    <h4>🔍 Advanced Filters</h4>
                    <div class="filter-grid">
                        <div class="input-group">
                            <label for="profileSearch">Search:</label>
                            <input type="text" id="profileSearch" placeholder="Name, server, bio..." oninput="applyFilters()">
                        </div>
                        <div class="input-group">
                            <label for="serverFilter">Server:</label>
                            <select id="serverFilter" onchange="applyFilters()">
                                <option value="">All Servers</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="nsfwFilter">NSFW Status:</label>
                            <select id="nsfwFilter" onchange="applyFilters()">
                                <option value="">All Profiles</option>
                                <option value="false">Safe Only</option>
                                <option value="true">NSFW Only</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="imageFilter">Has Image:</label>
                            <select id="imageFilter" onchange="applyFilters()">
                                <option value="">All</option>
                                <option value="true">With Image</option>
                                <option value="false">No Image</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="likesFilter">Like Count:</label>
                            <select id="likesFilter" onchange="applyFilters()">
                                <option value="">Any</option>
                                <option value="0">No Likes</option>
                                <option value="1-5">1-5 Likes</option>
                                <option value="6-20">6-20 Likes</option>
                                <option value="21+">21+ Likes</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="sortFilter">Sort By:</label>
                            <select id="sortFilter" onchange="applyFilters()">
                                <option value="likes">Most Liked</option>
                                <option value="newest">Newest First</option>
                                <option value="oldest">Oldest First</option>
                                <option value="name">Name A-Z</option>
                            </select>
                        </div>
                    </div>
                    <div class="filter-controls">
                        <button class="btn btn-primary" onclick="applyFilters()">Apply Filters</button>
                        <button class="btn btn-secondary" onclick="clearFilters()">Clear All</button>
                        <span id="filterResults" style="color: #4CAF50; margin-left: 15px;"></span>
                    </div>
                </div>
                
                <div class="pagination" id="profilesPagination" style="display: none;">
                    <button id="prevPageBtn" onclick="changePage(-1)">Previous</button>
                    <div class="pagination-info">
                        <span id="pageInfo">Page 1 of 1</span>
                        <span id="totalInfo">(0 profiles)</span>
                    </div>
                    <button id="nextPageBtn" onclick="changePage(1)">Next</button>
                </div>
                <div class="loading" id="profilesLoading">Loading profiles...</div>
                <div class="profile-grid" id="profilesGrid"></div>
                <div class="pagination" id="profilesPaginationBottom" style="display: none;">
                    <button onclick="changePage(-1)">Previous</button>
                    <div class="pagination-info">
                        <span id="pageInfoBottom">Page 1 of 1</span>
                    </div>
                    <button onclick="changePage(1)">Next</button>
                </div>
            </div>
            
            <div id="activity" class="tab-content">
                <h3>📊 Activity Feed</h3>
                <div style="display: flex; gap: 10px; margin-bottom: 20px; align-items: center;">
                    <select id="activityTypeFilter" onchange="loadActivityFeed()">
                        <option value="">All Activity</option>
                        <option value="upload">Profile Uploads</option>
                        <option value="like">Profile Likes</option>
                        <option value="report">Reports</option>
                        <option value="moderation">Moderation Actions</option>
                        <option value="flag">Auto-Flagged Content</option>
                    </select>
                    <button class="btn btn-primary" onclick="loadActivityFeed()" id="refreshActivityBtn">
                        🔄 Refresh
                    </button>
                    <label style="color: #ccc; margin-left: auto;">
                        <input type="checkbox" id="autoRefreshActivity" onchange="toggleAutoRefresh()"> Auto-refresh (30s)
                    </label>
                </div>
                <div class="loading" id="activityLoading">Loading activity...</div>
                <div id="activityContainer"></div>
            </div>
            
            <div id="flagged" class="tab-content">
                <h3>🚩 Auto-Flagged Content</h3>
                <div style="display: flex; gap: 10px; margin-bottom: 20px; align-items: center;">
                    <select id="flagStatusFilter" onchange="loadFlaggedProfiles()">
                        <option value="pending">Pending Review</option>
                        <option value="">All Flagged</option>
                        <option value="approved">Approved</option>
                        <option value="removed">Removed</option>
                    </select>
                    <button class="btn btn-primary" onclick="loadFlaggedProfiles()">🔄 Refresh</button>
                    <button class="btn btn-secondary" onclick="showKeywordManager()">Manage Keywords</button>
                </div>
                <div class="loading" id="flaggedLoading">Loading flagged content...</div>
                <div id="flaggedContainer"></div>
            </div>
            
            <div id="announcements" class="tab-content">
                <h3>Announcements</h3>
                <div class="input-group">
                    <label for="announcementTitle">Title:</label>
                    <input type="text" id="announcementTitle" placeholder="Announcement title">
                </div>
                <div class="input-group">
                    <label for="announcementMessage">Message:</label>
                    <textarea id="announcementMessage" rows="3" placeholder="Announcement message"></textarea>
                </div>
                <div class="input-group">
                    <label for="announcementType">Type:</label>
                    <select id="announcementType">
                        <option value="info">Info</option>
                        <option value="warning">Warning</option>
                        <option value="update">Update</option>
                        <option value="maintenance">Maintenance</option>
                    </select>
                </div>
                <button class="btn btn-primary" onclick="createAnnouncement()">Create Announcement</button>
                
                <div class="loading" id="announcementsLoading">Loading announcements...</div>
                <div id="announcementsContainer"></div>
            </div>
            
            <div id="reports" class="tab-content">
                <h3>Pending Reports</h3>
                <div class="loading" id="reportsLoading">Loading reports...</div>
                <div id="reportsContainer"></div>
            </div>
            
            <div id="archived" class="tab-content">
                <h3>Archived Reports</h3>
                <div class="input-group" style="max-width: 400px; margin-bottom: 20px;">
                    <label for="reportSearch">Search by Character Name:</label>
                    <input type="text" id="reportSearch" placeholder="Type character name..." oninput="filterArchivedReports()">
                </div>
                <div class="loading" id="archivedLoading">Loading archived reports...</div>
                <div id="archivedContainer"></div>
            </div>
            
            <div id="banned" class="tab-content">
                <h3>Banned Profiles</h3>
                <div class="loading" id="bannedLoading">Loading banned profiles...</div>
                <div id="bannedContainer"></div>
            </div>
            
            <div id="moderation" class="tab-content">
                <h3>Moderation Actions</h3>
                <div class="loading" id="moderationLoading">Loading moderation log...</div>
                <div id="moderationContainer"></div>
            </div>
        </div>
    </div>
    
    <!-- Image Modal for viewing full-size images -->
    <div id="imageModal" class="image-modal" onclick="closeImageModal()">
        <span class="image-modal-close" onclick="closeImageModal()">&times;</span>
        <img class="image-modal-content" id="modalImage">
    </div>

    <script>
        let adminKey = '';
        let adminName = '';
        let allProfiles = []; // Store all profiles for search filtering
        let filteredProfiles = []; // Store filtered profiles for pagination
        let currentPage = 1;
        const profilesPerPage = 24; // 4x6 grid looks good
        const serverUrl = window.location.origin;
        let activityRefreshInterval = null;
        let availableServers = new Set();
        
        // Bulk selection variables
        let selectedProfiles = new Set(); // Store selected profile IDs across pages
        let bulkActionInProgress = false;
        
        // Load saved admin credentials on page load
        document.addEventListener('DOMContentLoaded', function() {
            console.log('🔄 Page loaded, checking for saved credentials...');
            
            try {
                const savedAdminKey = localStorage.getItem('cs_admin_key');
                const savedAdminName = localStorage.getItem('cs_admin_name');
                
                console.log('📋 Saved credentials:', savedAdminKey ? 'Key found' : 'No key', savedAdminName ? 'Name found' : 'No name');
                
                if (savedAdminKey) {
                    document.getElementById('adminKey').value = savedAdminKey;
                    adminKey = savedAdminKey;
                }
                
                if (savedAdminName) {
                    document.getElementById('adminName').value = savedAdminName;
                    adminName = savedAdminName;
                }
                
                // Auto-load dashboard if both credentials are saved
                if (savedAdminKey && savedAdminName) {
                    console.log('🚀 Auto-loading dashboard with saved credentials...');
                    setTimeout(() => {
                        autoLoadDashboard();
                    }, 100);
                }
            } catch (e) {
                console.error('❌ Error loading saved credentials:', e);
            }
        });
        
        async function autoLoadDashboard() {
            try {
                // Test credentials first
                const testResponse = await fetch(\`\${serverUrl}/admin/dashboard?adminKey=\${adminKey}\`);
                
                if (!testResponse.ok) {
                    throw new Error('Invalid saved credentials');
                }
                
                console.log('✅ Saved credentials valid, loading dashboard...');
                await refreshStats();
                document.getElementById('dashboardContent').style.display = 'block';
                document.querySelector('.auth-section').style.display = 'none';
                loadProfiles();
                console.log('🎉 Dashboard auto-loaded successfully');
                
            } catch (error) {
                console.error('❌ Auto-load failed:', error);
                // Clear invalid credentials
                localStorage.removeItem('cs_admin_key');
                localStorage.removeItem('cs_admin_name');
                adminKey = '';
                adminName = '';
                document.getElementById('adminKey').value = '';
                document.getElementById('adminName').value = '';
                alert('Saved credentials expired. Please log in again.');
            }
        }
        
        function applyFilters() {
            const searchTerm = document.getElementById('profileSearch').value.toLowerCase();
            const serverFilter = document.getElementById('serverFilter').value;
            const nsfwFilter = document.getElementById('nsfwFilter').value;
            const imageFilter = document.getElementById('imageFilter').value;
            const likesFilter = document.getElementById('likesFilter').value;
            const sortFilter = document.getElementById('sortFilter').value;
            
            let filtered = [...allProfiles];
            
            // Apply search filter
            if (searchTerm) {
                filtered = filtered.filter(profile =>
                    profile.CharacterName.toLowerCase().includes(searchTerm) ||
                    profile.Server.toLowerCase().includes(searchTerm) ||
                    profile.CharacterId.toLowerCase().includes(searchTerm) ||
                    (profile.Bio && profile.Bio.toLowerCase().includes(searchTerm)) ||
                    (profile.GalleryStatus && profile.GalleryStatus.toLowerCase().includes(searchTerm)) ||
                    (profile.Race && profile.Race.toLowerCase().includes(searchTerm)) ||
                    (profile.Tags && profile.Tags.toLowerCase().includes(searchTerm))
                );
            }
            
            // Apply server filter
            if (serverFilter) {
                filtered = filtered.filter(profile => profile.Server === serverFilter);
            }
            
            // Apply NSFW filter
            if (nsfwFilter !== '') {
                const isNSFW = nsfwFilter === 'true';
                filtered = filtered.filter(profile => !!profile.IsNSFW === isNSFW);
            }
            
            // Apply image filter
            if (imageFilter !== '') {
                const hasImage = imageFilter === 'true';
                filtered = filtered.filter(profile => !!profile.ProfileImageUrl === hasImage);
            }
            
            // Apply likes filter
            if (likesFilter) {
                switch(likesFilter) {
                    case '0':
                        filtered = filtered.filter(profile => profile.LikeCount === 0);
                        break;
                    case '1-5':
                        filtered = filtered.filter(profile => profile.LikeCount >= 1 && profile.LikeCount <= 5);
                        break;
                    case '6-20':
                        filtered = filtered.filter(profile => profile.LikeCount >= 6 && profile.LikeCount <= 20);
                        break;
                    case '21+':
                        filtered = filtered.filter(profile => profile.LikeCount >= 21);
                        break;
                }
            }
            
            // Apply sorting
            switch(sortFilter) {
                case 'likes':
                    filtered.sort((a, b) => b.LikeCount - a.LikeCount);
                    break;
                case 'newest':
                    filtered.sort((a, b) => new Date(b.LastUpdated) - new Date(a.LastUpdated));
                    break;
                case 'oldest':
                    filtered.sort((a, b) => new Date(a.LastUpdated) - new Date(b.LastUpdated));
                    break;
                case 'name':
                    filtered.sort((a, b) => a.CharacterName.localeCompare(b.CharacterName));
                    break;
            }
            
            filteredProfiles = filtered;
            currentPage = 1;
            
            // Update results display
            document.getElementById('filterResults').textContent = \`\${filtered.length} profiles found\`;
            
            renderProfilesPage();
        }
        
        function clearFilters() {
            document.getElementById('profileSearch').value = '';
            document.getElementById('serverFilter').value = '';
            document.getElementById('nsfwFilter').value = '';
            document.getElementById('imageFilter').value = '';
            document.getElementById('likesFilter').value = '';
            document.getElementById('sortFilter').value = 'likes';
            
            // Clear saved filters and page
            localStorage.removeItem('cs_admin_filters');
            localStorage.removeItem('cs_admin_current_page');
            
            applyFilters();
        }
        
        function populateServerDropdown() {
            const serverSelect = document.getElementById('serverFilter');
            const currentValue = serverSelect.value;
            
            // Clear existing options except "All Servers"
            serverSelect.innerHTML = '<option value="">All Servers</option>';
            
            // Add server options
            const sortedServers = Array.from(availableServers).sort();
            sortedServers.forEach(server => {
                const option = document.createElement('option');
                option.value = server;
                option.textContent = server;
                serverSelect.appendChild(option);
            });
            
            // Restore previous selection if valid
            if (sortedServers.includes(currentValue)) {
                serverSelect.value = currentValue;
            }
        }
        
        function renderProfilesPage() {
            const startIndex = (currentPage - 1) * profilesPerPage;
            const endIndex = startIndex + profilesPerPage;
            const pageProfiles = filteredProfiles.slice(startIndex, endIndex);
            
            renderProfileCards(pageProfiles);
            updatePaginationControls();
        }
        
        function updatePaginationControls() {
            const totalPages = Math.ceil(filteredProfiles.length / profilesPerPage);
            const pagination = document.getElementById('profilesPagination');
            const paginationBottom = document.getElementById('profilesPaginationBottom');
            
            if (totalPages <= 1) {
                pagination.style.display = 'none';
                paginationBottom.style.display = 'none';
                return;
            }
            
            pagination.style.display = 'flex';
            paginationBottom.style.display = 'flex';
            
            // Update page info
            document.getElementById('pageInfo').textContent = \`Page \${currentPage} of \${totalPages}\`;
            document.getElementById('pageInfoBottom').textContent = \`Page \${currentPage} of \${totalPages}\`;
            document.getElementById('totalInfo').textContent = \`(\${filteredProfiles.length} profiles)\`;
            
            // Update buttons
            const prevButtons = [document.getElementById('prevPageBtn'), paginationBottom.querySelector('button:first-child')];
            const nextButtons = [document.getElementById('nextPageBtn'), paginationBottom.querySelector('button:last-child')];
            
            prevButtons.forEach(btn => {
                btn.disabled = currentPage === 1;
            });
            
            nextButtons.forEach(btn => {
                btn.disabled = currentPage === totalPages;
            });
        }
        
        function changePage(direction) {
            const totalPages = Math.ceil(filteredProfiles.length / profilesPerPage);
            const newPage = currentPage + direction;
            
            if (newPage >= 1 && newPage <= totalPages) {
                currentPage = newPage;
                
                // Save current page to localStorage for persistence
                localStorage.setItem('cs_admin_current_page', currentPage);
                
                renderProfilesPage();
                // Removed the annoying scroll to top behavior
            }
        }
        
        function renderProfileCards(profiles) {
            const grid = document.getElementById('profilesGrid');
            grid.innerHTML = '';
            
            profiles.forEach(profile => {
                const card = document.createElement('div');
                card.className = 'profile-card';
                
                // Mark card as selected if profile is already selected
                if (selectedProfiles.has(profile.CharacterId)) {
                    card.classList.add('selected');
                }
                
                // Create clickable image element or placeholder
                const imageHtml = profile.ProfileImageUrl 
                    ? \`<img src="\${profile.ProfileImageUrl}" 
                            alt="\${profile.CharacterName}" 
                            class="profile-image" 
                            onclick="openImageModal('\${profile.ProfileImageUrl}', '\${profile.CharacterName}')"
                            onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                       <div class="profile-image-placeholder" style="display: none;">🖼️</div>\`
                    : \`<div class="profile-image-placeholder">🖼️</div>\`;
                
                // Format character name with NSFW badge if needed
                const characterNameHtml = \`
                    <div class="profile-name">
                        \${profile.CharacterName}
                        \${profile.IsNSFW ? '<span class="nsfw-badge">🔞 NSFW</span>' : ''}
                    </div>
                \`;
                
                // Show either Gallery Status OR Bio (Gallery Status takes priority)
                let contentHtml = '';
                if (profile.GalleryStatus && profile.GalleryStatus.trim()) {
                    contentHtml = \`<div class="gallery-status">\${profile.GalleryStatus}</div>\`;
                } else if (profile.Bio && profile.Bio.trim()) {
                    contentHtml = \`<div class="profile-content">\${profile.Bio}</div>\`;
                } else {
                    contentHtml = \`<div class="profile-content" style="color: #999; font-style: italic;">No bio</div>\`;
                }
                
                // FIXED: NSFW profiles only get Remove and Ban buttons (NO NSFW BUTTON!)
                const actionButtons = profile.IsNSFW ? \`
                    <button class="btn btn-danger" onclick="confirmRemoveProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                        Remove
                    </button>
                    <button class="btn btn-warning" onclick="confirmBanProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                        Ban
                    </button>
                \` : \`
                    <button class="btn btn-danger" onclick="confirmRemoveProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                        Remove
                    </button>
                    <button class="btn btn-warning" onclick="confirmBanProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                        Ban
                    </button>
                    <button class="btn btn-nsfw" onclick="confirmToggleNSFW('\${profile.CharacterId}', '\${profile.CharacterName}', false)">
                        Mark NSFW
                    </button>
                \`;
                
                card.innerHTML = \`
                    <div class="profile-header">
                        <div class="profile-info">
                            \${characterNameHtml}
                            <div class="profile-id">\${profile.CharacterId}</div>
                            <div style="margin-top: 8px; display: flex; align-items: center; gap: 10px;">
                                <span style="color: #ccc; font-size: 0.9em;">\${profile.Server}</span>
                                <span style="color: #4CAF50;">❤️ \${profile.LikeCount}</span>
                            </div>
                        </div>
                        <div style="text-align: center;">
                            \${imageHtml}
                            <input type="checkbox" class="profile-checkbox" data-profile-id="\${profile.CharacterId}" \${selectedProfiles.has(profile.CharacterId) ? 'checked' : ''} onchange="toggleProfileSelection('\${profile.CharacterId}', this); this.checked ? this.closest('.profile-card').classList.add('selected') : this.closest('.profile-card').classList.remove('selected');">
                        </div>
                    </div>
                    \${contentHtml}
                    <div class="profile-actions">
                        \${actionButtons}
                    </div>
                \`;
                grid.appendChild(card);
            });
        }
        
        async function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName).classList.add('active');
            event.target.classList.add('active');
            
            // Auto-refresh stats when switching tabs
            await refreshStats();
            
            switch(tabName) {
                case 'profiles':
                    loadProfiles();
                    break;
                case 'activity':
                    loadActivityFeed();
                    break;
                case 'flagged':
                    loadFlaggedProfiles();
                    break;
                case 'announcements':
                    loadAnnouncements();
                    break;
                case 'reports':
                    loadReports();
                    break;
                case 'archived':
                    loadArchivedReports();
                    break;
                case 'banned':
                    loadBannedProfiles();
                    break;
                case 'moderation':
                    loadModerationLog();
                    break;
            }
        }
        
        async function loadDashboard() {
            adminKey = document.getElementById('adminKey').value;
            adminName = document.getElementById('adminName').value;
            
            if (!adminKey) {
                alert('Please enter your admin key');
                return;
            }
            
            if (!adminName) {
                alert('Please enter your admin name');
                return;
            }
            
            try {
                console.log('🔐 Testing credentials before saving...');
                await refreshStats();
                
                // Only save credentials AFTER successful authentication
                console.log('✅ Authentication successful, saving credentials...');
                localStorage.setItem('cs_admin_key', adminKey);
                localStorage.setItem('cs_admin_name', adminName);
                console.log('💾 Credentials saved to localStorage');
                
                document.getElementById('dashboardContent').style.display = 'block';
                document.querySelector('.auth-section').style.display = 'none';
                loadProfiles();
                
            } catch (error) {
                console.error('❌ Authentication failed:', error);
                alert(\`Error: \${error.message}\`);
                // Don't save credentials if login fails
            }
        }
        
        // Bulk selection functions
        function toggleProfileSelection(profileId, checkbox) {
            if (checkbox.checked) {
                selectedProfiles.add(profileId);
            } else {
                selectedProfiles.delete(profileId);
            }
            updateSelectionUI();
        }
        
        function toggleSelectAll() {
            const selectAllCheckbox = document.getElementById('selectAllCheckbox');
            const checkboxes = document.querySelectorAll('.profile-checkbox');
            
            checkboxes.forEach(checkbox => {
                const profileId = checkbox.getAttribute('data-profile-id');
                checkbox.checked = selectAllCheckbox.checked;
                
                if (selectAllCheckbox.checked) {
                    selectedProfiles.add(profileId);
                    checkbox.closest('.profile-card').classList.add('selected');
                } else {
                    selectedProfiles.delete(profileId);
                    checkbox.closest('.profile-card').classList.remove('selected');
                }
            });
            
            updateSelectionUI();
        }
        
        function updateSelectionUI() {
            const count = selectedProfiles.size;
            const bulkActionBar = document.getElementById('bulkActionBar');
            const selectionCount = document.getElementById('bulkSelectionCount');
            
            if (count > 0) {
                bulkActionBar.classList.add('show');
                selectionCount.textContent = count + ' selected';
            } else {
                bulkActionBar.classList.remove('show');
            }
            
            // Update select all checkbox state
            const selectAllCheckbox = document.getElementById('selectAllCheckbox');
            const visibleCheckboxes = document.querySelectorAll('.profile-checkbox');
            const visibleSelected = Array.from(visibleCheckboxes).filter(cb => cb.checked).length;
            
            if (visibleSelected === 0) {
                selectAllCheckbox.indeterminate = false;
                selectAllCheckbox.checked = false;
            } else if (visibleSelected === visibleCheckboxes.length) {
                selectAllCheckbox.indeterminate = false;
                selectAllCheckbox.checked = true;
            } else {
                selectAllCheckbox.indeterminate = true;
            }
        }
        
        function clearAllSelections() {
            selectedProfiles.clear();
            
            // Uncheck all checkboxes and remove selection styling
            document.querySelectorAll('.profile-checkbox').forEach(checkbox => {
                checkbox.checked = false;
            });
            
            document.querySelectorAll('.profile-card').forEach(card => {
                card.classList.remove('selected');
            });
            
            updateSelectionUI();
            alert('Selection cleared');
        }
        
        // Bulk action functions
        async function bulkRemoveProfiles() {
            if (selectedProfiles.size === 0) {
                alert('No profiles selected');
                return;
            }
            
            const reason = document.getElementById('bulkActionReason').value.trim();
            if (!reason) {
                alert('Please enter a reason for removal');
                return;
            }
            
            if (!confirm('Are you sure you want to remove ' + selectedProfiles.size + ' selected profiles? This action cannot be undone.')) {
                return;
            }
            
            bulkActionInProgress = true;
            const profileIds = Array.from(selectedProfiles);
            let completed = 0;
            let errors = 0;
            
            for (const profileId of profileIds) {
                try {
                    const response = await fetch('/admin/profiles/' + encodeURIComponent(profileId), {
                        method: 'DELETE',
                        headers: {
                            'Content-Type': 'application/json',
                            'Admin-Key': adminKey,
                            'Admin-Name': adminName
                        },
                        body: JSON.stringify({
                            reason: reason
                        })
                    });
                    
                    if (response.ok) {
                        completed++;
                        selectedProfiles.delete(profileId);
                    } else {
                        errors++;
                    }
                } catch (error) {
                    errors++;
                }
            }
            
            bulkActionInProgress = false;
            updateSelectionUI();
            
            if (errors === 0) {
                alert('Successfully removed ' + completed + ' profiles');
            } else {
                alert('Removed ' + completed + ' profiles with ' + errors + ' errors');
            }
            
            // Refresh the profiles view
            if (document.getElementById('profiles').classList.contains('active')) {
                loadProfiles();
            }
        }
        
        async function bulkBanProfiles() {
            if (selectedProfiles.size === 0) {
                alert('No profiles selected');
                return;
            }
            
            const reason = document.getElementById('bulkActionReason').value.trim();
            if (!reason) {
                alert('Please enter a reason for banning');
                return;
            }
            
            if (!confirm('Are you sure you want to ban ' + selectedProfiles.size + ' selected profiles?')) {
                return;
            }
            
            bulkActionInProgress = true;
            const profileIds = Array.from(selectedProfiles);
            let completed = 0;
            let errors = 0;
            
            for (const profileId of profileIds) {
                try {
                    const response = await fetch('/admin/profiles/' + encodeURIComponent(profileId) + '/ban', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Admin-Key': adminKey,
                            'Admin-Name': adminName
                        },
                        body: JSON.stringify({
                            reason: reason
                        })
                    });
                    
                    if (response.ok) {
                        completed++;
                        selectedProfiles.delete(profileId);
                    } else {
                        errors++;
                    }
                } catch (error) {
                    errors++;
                }
            }
            
            bulkActionInProgress = false;
            updateSelectionUI();
            
            if (errors === 0) {
                alert('Successfully banned ' + completed + ' profiles');
            } else {
                alert('Banned ' + completed + ' profiles with ' + errors + ' errors');
            }
            
            // Refresh the profiles view
            if (document.getElementById('profiles').classList.contains('active')) {
                loadProfiles();
            }
        }
        
        async function bulkMarkNSFW() {
            if (selectedProfiles.size === 0) {
                alert('No profiles selected');
                return;
            }
            
            const reason = document.getElementById('bulkActionReason').value.trim();
            if (!reason) {
                alert('Please enter a reason for marking as NSFW');
                return;
            }
            
            if (!confirm('Are you sure you want to mark ' + selectedProfiles.size + ' selected profiles as NSFW?')) {
                return;
            }
            
            bulkActionInProgress = true;
            const profileIds = Array.from(selectedProfiles);
            let completed = 0;
            let skipped = 0;
            let errors = 0;
            
            for (const profileId of profileIds) {
                try {
                    // First check if profile is already NSFW
                    const profile = allProfiles.find(p => p.CharacterId === profileId);
                    if (profile && profile.IsNSFW) {
                        skipped++;
                        selectedProfiles.delete(profileId);
                        continue;
                    }
                    
                    const response = await fetch('/admin/profiles/' + encodeURIComponent(profileId) + '/nsfw', {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'Admin-Key': adminKey,
                            'Admin-Name': adminName
                        },
                        body: JSON.stringify({
                            isNSFW: true
                        })
                    });
                    
                    if (response.ok) {
                        completed++;
                        selectedProfiles.delete(profileId);
                    } else {
                        errors++;
                    }
                } catch (error) {
                    errors++;
                }
            }
            
            bulkActionInProgress = false;
            updateSelectionUI();
            
            let message = 'Marked ' + completed + ' profiles as NSFW';
            if (skipped > 0) {
                message = message + ', skipped ' + skipped + ' already NSFW';
            }
            if (errors > 0) {
                message = message + ' with ' + errors + ' errors';
            }
            
            alert(message);
            
            // Refresh the profiles view
            if (document.getElementById('profiles').classList.contains('active')) {
                loadProfiles();
            }
        }
        
        // Modal functions
        let modalAction = null;
        let modalData = null;
        
        function showModal(title, body, confirmText, confirmClass, actionName, data) {
            document.getElementById('modalTitle').textContent = title;
            document.getElementById('modalBody').innerHTML = body;
            
            const confirmBtn = document.getElementById('modalConfirmBtn');
            confirmBtn.textContent = confirmText;
            confirmBtn.className = 'btn ' + confirmClass;
            
            modalAction = actionName;
            modalData = data;
            
            document.getElementById('confirmModal').classList.add('show');
        }
        
        function closeModal() {
            document.getElementById('confirmModal').classList.remove('show');
            modalAction = null;
            modalData = null;
        }
        
        async function confirmModalAction() {
            if (modalAction && modalData) {
                console.log('Modal action:', modalAction, 'Data:', modalData);
                closeModal();
                
                // Dispatch to the correct function
                if (modalAction === 'removeProfile') {
                    await removeProfile(modalData);
                } else if (modalAction === 'banProfile') {
                    await banProfile(modalData);
                } else if (modalAction === 'toggleNSFW') {
                    await toggleNSFW(modalData);
                } else {
                    console.error('Unknown modal action:', modalAction);
                    alert('Error: Unknown action');
                }
            } else {
                console.error('No modal action or data set');
                alert('Error: No modal action set');
            }
        }
        
        // Individual profile action functions (updated to use modals)
        function confirmRemoveProfile(characterId, characterName) {
            const body = \`
                <p>Are you sure you want to <strong>remove</strong> this profile?</p>
                <div class="profile-info">
                    <strong>Character:</strong> \${characterName}<br>
                    <strong>ID:</strong> \${characterId}
                </div>
                <div class="input-group" style="margin-top: 15px;">
                    <label for="removeReason">Reason for removal:</label>
                    <input type="text" id="removeReason" placeholder="Enter reason..." style="width: 100%; padding: 8px; margin-top: 5px; border: 1px solid #ccc; border-radius: 4px;">
                </div>
                <p style="color: #f44336; margin-top: 10px; font-size: 0.9em;"><strong>Warning:</strong> This action cannot be undone.</p>
            \`;
            
            showModal('Remove Profile', body, 'Remove', 'btn-danger', 'removeProfile', { characterId, characterName });
        }
        
        function confirmBanProfile(characterId, characterName) {
            const body = \`
                <p>Are you sure you want to <strong>ban</strong> this profile?</p>
                <div class="profile-info">
                    <strong>Character:</strong> \${characterName}<br>
                    <strong>ID:</strong> \${characterId}
                </div>
                <div class="input-group" style="margin-top: 15px;">
                    <label for="banReason">Reason for ban:</label>
                    <input type="text" id="banReason" placeholder="Enter reason..." style="width: 100%; padding: 8px; margin-top: 5px; border: 1px solid #ccc; border-radius: 4px;">
                </div>
                <p style="color: #ff9800; margin-top: 10px; font-size: 0.9em;">This will prevent the profile from being uploaded again.</p>
            \`;
            
            showModal('Ban Profile', body, 'Ban', 'btn-warning', 'banProfile', { characterId, characterName });
        }
        
        function confirmToggleNSFW(characterId, characterName, isCurrentlyNSFW) {
            const action = isCurrentlyNSFW ? 'unmark from' : 'mark as';
            const actionCaps = isCurrentlyNSFW ? 'Unmark' : 'Mark';
            
            const body = \`
                <p>Are you sure you want to <strong>\${action} NSFW</strong> this profile?</p>
                <div class="profile-info">
                    <strong>Character:</strong> \${characterName}<br>
                    <strong>ID:</strong> \${characterId}<br>
                    <strong>Current Status:</strong> \${isCurrentlyNSFW ? 'NSFW' : 'Safe'}
                </div>
                <div class="input-group" style="margin-top: 15px;">
                    <label for="nsfwReason">Reason:</label>
                    <input type="text" id="nsfwReason" placeholder="Enter reason..." style="width: 100%; padding: 8px; margin-top: 5px; border: 1px solid #ccc; border-radius: 4px;">
                </div>
            \`;
            
            showModal(\`\${actionCaps} NSFW\`, body, actionCaps, 'btn-nsfw', 'toggleNSFW', { characterId, characterName, isNSFW: !isCurrentlyNSFW });
        }
        
        // Updated action functions
        async function removeProfile(data) {
            const reason = document.getElementById('removeReason')?.value?.trim();
            if (!reason) {
                alert('Please enter a reason for removal');
                return;
            }
            
            try {
                const response = await fetch('/admin/profiles/' + encodeURIComponent(data.characterId), {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        'Admin-Key': adminKey,
                        'Admin-Name': adminName
                    },
                    body: JSON.stringify({
                        reason: reason
                    })
                });
                
                if (response.ok) {
                    alert('Profile removed successfully');
                    loadProfiles();
                } else {
                    alert('Failed to remove profile');
                }
            } catch (error) {
                alert('Error removing profile: ' + error.message);
            }
        }
        
        async function banProfile(data) {
            const reason = document.getElementById('banReason')?.value?.trim();
            if (!reason) {
                alert('Please enter a reason for ban');
                return;
            }
            
            try {
                const response = await fetch('/admin/profiles/' + encodeURIComponent(data.characterId) + '/ban', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Admin-Key': adminKey,
                        'Admin-Name': adminName
                    },
                    body: JSON.stringify({
                        reason: reason
                    })
                });
                
                if (response.ok) {
                    alert('Profile banned successfully');
                    loadProfiles();
                } else {
                    alert('Failed to ban profile');
                }
            } catch (error) {
                alert('Error banning profile: ' + error.message);
            }
        }
        
        async function toggleNSFW(data) {
            const reason = document.getElementById('nsfwReason')?.value?.trim();
            if (!reason) {
                alert('Please enter a reason');
                return;
            }
            
            try {
                const response = await fetch('/admin/profiles/' + encodeURIComponent(data.characterId) + '/nsfw', {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'Admin-Key': adminKey,
                        'Admin-Name': adminName
                    },
                    body: JSON.stringify({
                        isNSFW: data.isNSFW
                    })
                });
                
                if (response.ok) {
                    alert('Profile NSFW status updated successfully');
                    loadProfiles();
                } else {
                    alert('Failed to update NSFW status');
                }
            } catch (error) {
                alert('Error updating NSFW status: ' + error.message);
            }
        }
        
        async function refreshStats() {
            if (!adminKey) return;
            
            const refreshBtn = document.getElementById('refreshBtn');
            if (refreshBtn) {
                refreshBtn.textContent = '🔄 Refreshing...';
                refreshBtn.disabled = true;
            }
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/dashboard?adminKey=\${adminKey}\`);
                if (!response.ok) {
                    throw new Error('Failed to load stats');
                }
                
                const stats = await response.json();
                
                document.getElementById('totalProfiles').textContent = stats.totalProfiles;
                document.getElementById('pendingReports').textContent = stats.pendingReports;
                document.getElementById('totalBanned').textContent = stats.totalBanned;
                document.getElementById('activeAnnouncements').textContent = stats.activeAnnouncements;
                
            } catch (error) {
                console.error('Error refreshing:', error);
            } finally {
                if (refreshBtn) {
                    refreshBtn.textContent = '🔄 Refresh All';
                    refreshBtn.disabled = false;
                }
            }
        }
        
        async function loadProfiles() {
            const loading = document.getElementById('profilesLoading');
            const grid = document.getElementById('profilesGrid');
            
            loading.style.display = 'block';
            grid.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/gallery?admin=true&key=\${adminKey}\`);
                const profiles = await response.json();
                
                loading.style.display = 'none';
                allProfiles = profiles;
                
                // Populate available servers
                availableServers.clear();
                profiles.forEach(profile => {
                    if (profile.Server) {
                        availableServers.add(profile.Server);
                    }
                });
                populateServerDropdown();
                
                // Apply initial filters
                applyFilters();
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading profiles: \${error.message}</div>\`;
            }
        }
        
        // Activity Feed Functions
        async function loadActivityFeed() {
            const loading = document.getElementById('activityLoading');
            const container = document.getElementById('activityContainer');
            const typeFilter = document.getElementById('activityTypeFilter').value;
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                let url = \`\${serverUrl}/admin/activity?adminKey=\${adminKey}\`;
                if (typeFilter) {
                    url += \`&type=\${typeFilter}\`;
                }
                
                const response = await fetch(url);
                const activities = await response.json();
                
                loading.style.display = 'none';
                
                if (activities.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #ccc; padding: 20px;">📭 No activity to show</div>';
                    return;
                }
                
                activities.forEach(activity => {
                    const item = document.createElement('div');
                    item.className = \`activity-item \${activity.type}\`;
                    
                    const timeAgo = getTimeAgo(activity.timestamp);
                    let metadataText = '';
                    
                    if (activity.metadata) {
                        const meta = activity.metadata;
                        switch(activity.type) {
                            case 'upload':
                                metadataText = \`Server: \${meta.server || 'Unknown'}\${meta.hasImage ? ' • Has Image' : ''}\`;
                                break;
                            case 'like':
                                metadataText = \`Total Likes: \${meta.newCount || 0}\`;
                                break;
                            case 'report':
                                metadataText = \`Reason: \${meta.reason || 'Unknown'} • Reporter: \${meta.reporterCharacter || 'Anonymous'}\`;
                                break;
                            case 'moderation':
                                metadataText = \`Action: \${meta.action || 'Unknown'} • Admin: \${meta.adminId || 'Unknown'}\`;
                                break;
                            case 'flag':
                                metadataText = \`Keywords: \${meta.keywords ? meta.keywords.join(', ') : 'Unknown'}\`;
                                break;
                        }
                    }
                    
                    item.innerHTML = \`
                        <div class="activity-content">
                            <div class="activity-message">\${activity.message}</div>
                            \${metadataText ? \`<div class="activity-metadata">\${metadataText}</div>\` : ''}
                        </div>
                        <div class="activity-time">\${timeAgo}</div>
                    \`;
                    
                    container.appendChild(item);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading activity: \${error.message}</div>\`;
            }
        }
        
        function toggleAutoRefresh() {
            const checkbox = document.getElementById('autoRefreshActivity');
            const refreshBtn = document.getElementById('refreshActivityBtn');
            
            if (checkbox.checked) {
                activityRefreshInterval = setInterval(() => {
                    if (document.querySelector('.tab.active').onclick.toString().includes('activity')) {
                        loadActivityFeed();
                    }
                }, 30000); // 30 seconds
                refreshBtn.textContent = '🔄 Auto-refreshing (30s)';
            } else {
                if (activityRefreshInterval) {
                    clearInterval(activityRefreshInterval);
                    activityRefreshInterval = null;
                }
                refreshBtn.textContent = '🔄 Refresh';
            }
        }
        
        function getTimeAgo(timestamp) {
            const now = new Date();
            const time = new Date(timestamp);
            const diffMs = now - time;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);
            
            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return \`\${diffMins}m ago\`;
            if (diffHours < 24) return \`\${diffHours}h ago\`;
            if (diffDays < 7) return \`\${diffDays}d ago\`;
            
            return time.toLocaleDateString();
        }
        
        // Auto-Flagging Functions
        async function loadFlaggedProfiles() {
            const loading = document.getElementById('flaggedLoading');
            const container = document.getElementById('flaggedContainer');
            const statusFilter = document.getElementById('flagStatusFilter').value;
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                let url = \`\${serverUrl}/admin/flagged?adminKey=\${adminKey}\`;
                if (statusFilter) {
                    url += \`&status=\${statusFilter}\`;
                }
                
                const response = await fetch(url);
                const flaggedProfiles = await response.json();
                
                loading.style.display = 'none';
                
                if (flaggedProfiles.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #4CAF50; padding: 20px;">🎉 No flagged content!</div>';
                    return;
                }
                
                flaggedProfiles.forEach(flag => {
                    const card = document.createElement('div');
                    card.className = 'flagged-card';
                    
                    const timeAgo = getTimeAgo(flag.flaggedAt);
                    const keywordsHtml = flag.flaggedKeywords.map(kw => 
                        \`<span class="flagged-keywords">\${kw}</span>\`
                    ).join('');
                    
                    const statusBadge = flag.status === 'pending' ? 
                        '<span style="background: rgba(255, 152, 0, 0.2); color: #ff9800; padding: 4px 8px; border-radius: 4px;">⏳ PENDING</span>' :
                        flag.status === 'approved' ?
                        '<span style="background: rgba(76, 175, 80, 0.2); color: #4CAF50; padding: 4px 8px; border-radius: 4px;">✅ APPROVED</span>' :
                        '<span style="background: rgba(244, 67, 54, 0.2); color: #f44336; padding: 4px 8px; border-radius: 4px;">❌ REMOVED</span>';
                    
                    const actionButtons = flag.status === 'pending' ? \`
                        <div style="margin-top: 10px;">
                            <button class="btn btn-primary" onclick="updateFlagStatus('\${flag.id}', 'approved')">Approve</button>
                            <button class="btn btn-danger" onclick="updateFlagStatus('\${flag.id}', 'removed')">Remove</button>
                            <button class="btn btn-warning" onclick="confirmRemoveProfile('\${flag.characterId}', '\${flag.characterName}')">Remove Profile</button>
                        </div>
                    \` : '';
                    
                    card.innerHTML = \`
                        <div class="flagged-header">
                            <strong>\${flag.characterName}</strong>
                            \${statusBadge}
                        </div>
                        <div style="margin: 10px 0;">
                            <strong>Flagged Keywords:</strong><br>
                            \${keywordsHtml}
                        </div>
                        <div class="flagged-content">
                            \${flag.content}
                        </div>
                        <div style="margin-top: 10px; font-size: 0.9em; color: #aaa;">
                            <strong>Flagged:</strong> \${timeAgo}
                            \${flag.reviewedBy ? \` • <strong>Reviewed by:</strong> \${flag.reviewedBy}\` : ''}
                        </div>
                        \${actionButtons}
                    \`;
                    
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading flagged content: \${error.message}</div>\`;
            }
        }
        
        async function updateFlagStatus(flagId, status) {
            try {
                const response = await fetch(\`\${serverUrl}/admin/flagged/\${flagId}\`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ status })
                });
                
                if (response.ok) {
                    alert(\`✅ Flag \${status}\`);
                    loadFlaggedProfiles();
                } else {
                    alert('❌ Error updating flag status');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        function showKeywordManager() {
            // Simple keyword manager for now
            const newKeyword = prompt('Add new keyword to auto-flag list:\\n(Leave empty to cancel)');
            if (newKeyword && newKeyword.trim()) {
                addFlagKeyword(newKeyword.trim());
            }
        }
        
        async function addFlagKeyword(keyword) {
            try {
                const response = await fetch(\`\${serverUrl}/admin/flagged/keywords\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ keyword })
                });
                
                if (response.ok) {
                    alert(\`✅ Added keyword: "\${keyword}"\`);
                } else {
                    alert('❌ Error adding keyword');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        async function confirmRemoveProfile(characterId, characterName) {
            const action = confirm(\`🗑️ REMOVE PROFILE\\n\\nCharacter: \${characterName}\\n\\nThis will remove their profile from the gallery.\\nThey can still upload new profiles unless banned separately.\\n\\nClick OK to continue, Cancel to abort.\`);
            
            if (!action) return;
            
            const reason = prompt(\`📝 REMOVAL REASON\\n\\nWhy are you removing "\${characterName}"?\\n\\n(This will be logged for moderation records)\`);
            if (!reason || reason.trim() === '') {
                alert('❌ Removal cancelled - reason is required');
                return;
            }
            
            const finalConfirm = confirm(\`⚠️ FINAL CONFIRMATION\\n\\nRemove "\${characterName}" from gallery?\\nReason: \${reason}\\n\\nThis action cannot be undone.\\n\\nClick OK to REMOVE PROFILE\`);
            if (!finalConfirm) return;
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}\`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ reason, ban: false, adminId: adminName })
                });
                
                if (response.ok) {
                    alert(\`✅ "\${characterName}" has been removed from gallery\`);
                    loadProfiles();
                    await refreshStats();
                } else {
                    alert('❌ Error removing profile');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        async function confirmBanProfile(characterId, characterName) {
            const action = confirm(\`🚫 BAN PROFILE\\n\\nCharacter: \${characterName}\\n\\nThis will permanently ban them from uploading any profiles.\\nTheir current profile will remain in the gallery unless removed separately.\\n\\nClick OK to continue, Cancel to abort.\`);
            
            if (!action) return;
            
            const reason = prompt(\`📝 BAN REASON\\n\\nWhy are you banning "\${characterName}"?\\n\\n(This will be logged for moderation records)\`);
            if (!reason || reason.trim() === '') {
                alert('❌ Ban cancelled - reason is required'); 
                return;
            }
            
            const finalConfirm = confirm(\`⚠️ FINAL CONFIRMATION\\n\\nPermanently ban "\${characterName}"?\\nReason: \${reason}\\n\\nThey will not be able to upload new profiles.\\n\\nClick OK to BAN PROFILE\`);
            if (!finalConfirm) return;
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}/ban\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ reason, adminId: adminName })
                });
                
                if (response.ok) {
                    alert(\`✅ "\${characterName}" has been banned\`);
                    await refreshStats();
                } else {
                    alert('❌ Error banning profile');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        // Image modal functions
        function openImageModal(imageUrl, characterName) {
            const modal = document.getElementById('imageModal');
            const modalImg = document.getElementById('modalImage');
            modal.style.display = 'block';
            modalImg.src = imageUrl;
            modalImg.alt = characterName;
        }
        
        function closeImageModal() {
            document.getElementById('imageModal').style.display = 'none';
        }
        
        // Close modal when pressing Escape key
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
                closeImageModal();
            }
        });
        
        async function unbanProfile(characterId, characterName) {
            const reason = prompt(\`Why are you unbanning \${characterName || characterId}?\`);
            if (!reason) return;
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}/unban\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ reason })
                });
                
                if (response.ok) {
                    alert(\`\${characterName || characterId} has been unbanned\`);
                    await loadBannedProfiles();
                    await refreshStats();
                } else {
                    alert('Error unbanning profile');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function loadBannedProfiles() {
            const loading = document.getElementById('bannedLoading');
            const container = document.getElementById('bannedContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/moderation/banned?adminKey=\${adminKey}\`);
                const bannedIds = await response.json();
                
                loading.style.display = 'none';
                
                if (bannedIds.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #4CAF50; padding: 20px;">🎉 No banned profiles!</div>';
                    return;
                }
                
                // Try to get profile info for each banned ID
                const galleryResponse = await fetch(\`\${serverUrl}/gallery?admin=true&key=\${adminKey}\`);
                const allProfiles = galleryResponse.ok ? await galleryResponse.json() : [];
                
                bannedIds.forEach(bannedId => {
                    const card = document.createElement('div');
                    card.className = 'profile-card';
                    card.style.borderLeft = '4px solid #f44336';
                    
                    // Try to find profile info
                    const profile = allProfiles.find(p => p.CharacterId === bannedId);
                    
                    if (profile) {
                        // Profile still exists - show full info
                        const imageHtml = profile.ProfileImageUrl 
                            ? \`<img src="\${profile.ProfileImageUrl}" 
                                    alt="\${profile.CharacterName}" 
                                    class="profile-image" 
                                    onclick="openImageModal('\${profile.ProfileImageUrl}', '\${profile.CharacterName}')"
                                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                               <div class="profile-image-placeholder" style="display: none;">🖼️</div>\`
                            : \`<div class="profile-image-placeholder">🖼️</div>\`;
                        
                        card.innerHTML = \`
                            <div class="profile-header">
                                <div class="profile-info">
                                    <div class="profile-name" style="color: #f44336;">🚫 \${profile.CharacterName}</div>
                                    <div class="profile-id">\${profile.CharacterId}</div>
                                    <div style="margin-top: 8px; display: flex; align-items: center; gap: 10px;">
                                        <span style="color: #ccc; font-size: 0.9em;">\${profile.Server}</span>
                                        <span style="color: #f44336;">BANNED</span>
                                    </div>
                                </div>
                                \${imageHtml}
                            </div>
                            <div class="profile-content">
                                \${profile.Bio || profile.GalleryStatus || 'No bio'}
                            </div>
                            <div class="profile-actions">
                                <button class="btn btn-primary" onclick="unbanProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                                    Unban
                                </button>
                            </div>
                        \`;
                    } else {
                        // Profile doesn't exist anymore - show basic info
                        card.innerHTML = \`
                            <div class="profile-header">
                                <div class="profile-info">
                                    <div class="profile-name" style="color: #f44336;">🚫 \${bannedId}</div>
                                    <div class="profile-id">Profile Removed</div>
                                    <div style="margin-top: 8px;">
                                        <span style="color: #f44336;">BANNED</span>
                                    </div>
                                </div>
                                <div class="profile-image-placeholder">❌</div>
                            </div>
                            <div class="profile-content">
                                Profile was removed but ban still active
                            </div>
                            <div class="profile-actions">
                                <button class="btn btn-primary" onclick="unbanProfile('\${bannedId}', '\${bannedId}')">
                                    Unban
                                </button>
                            </div>
                        \`;
                    }
                    
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading banned profiles: \${error.message}</div>\`;
            }
        }
        
        async function loadReports() {
            const loading = document.getElementById('reportsLoading');
            const container = document.getElementById('reportsContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/reports?status=pending&adminKey=\${adminKey}\`);
                const reports = await response.json();
                
                loading.style.display = 'none';
                
                if (reports.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #4CAF50; padding: 20px;">🎉 No pending reports!</div>';
                    return;
                }
                
                await renderReports(reports, container);
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading reports: \${error.message}</div>\`;
            }
        }
        
        // Global variable to store all archived reports for filtering
        let allArchivedReports = [];
        
        async function loadArchivedReports() {
            const loading = document.getElementById('archivedLoading');
            const container = document.getElementById('archivedContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/reports?adminKey=\${adminKey}\`);
                const allReports = await response.json();
                
                // Filter for resolved and dismissed reports
                allArchivedReports = allReports.filter(report => 
                    report.status === 'resolved' || report.status === 'dismissed'
                );
                
                loading.style.display = 'none';
                
                if (allArchivedReports.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #ccc; padding: 20px;">📁 No archived reports</div>';
                    return;
                }
                
                await renderReports(allArchivedReports, container, true);
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading archived reports: \${error.message}</div>\`;
            }
        }
        
        function filterArchivedReports() {
            const searchTerm = document.getElementById('reportSearch').value.toLowerCase();
            const container = document.getElementById('archivedContainer');
            
            if (!searchTerm) {
                renderReports(allArchivedReports, container, true);
                return;
            }
            
            const filteredReports = allArchivedReports.filter(report =>
                report.reportedCharacterName.toLowerCase().includes(searchTerm) ||
                report.reporterCharacter.toLowerCase().includes(searchTerm)
            );
            
            renderReports(filteredReports, container, true);
        }
        
        async function renderReports(reports, container, isArchived = false) {
            container.innerHTML = '';
            
            // Group reports by reported character for archived view
            if (isArchived) {
                const groupedReports = {};
                reports.forEach(report => {
                    if (!groupedReports[report.reportedCharacterName]) {
                        groupedReports[report.reportedCharacterName] = [];
                    }
                    groupedReports[report.reportedCharacterName].push(report);
                });
                
                // Add summary header for archived reports
                const summary = document.createElement('div');
                summary.style.cssText = 'background: rgba(255, 255, 255, 0.05); padding: 10px; border-radius: 8px; margin-bottom: 15px; color: #ccc;';
                const uniqueReported = Object.keys(groupedReports).length;
                const totalReports = reports.length;
                const repeatOffenders = Object.entries(groupedReports).filter(([name, reports]) => reports.length > 1);
                
                summary.innerHTML = \`
                    📊 \${totalReports} archived reports for \${uniqueReported} characters
                    \${repeatOffenders.length > 0 ? \`<br>⚠️ \${repeatOffenders.length} characters with multiple reports\` : ''}
                \`;
                container.appendChild(summary);
                
                // Show repeat offenders if any
                if (repeatOffenders.length > 0) {
                    const repeatDiv = document.createElement('div');
                    repeatDiv.style.cssText = 'background: rgba(255, 152, 0, 0.1); border: 1px solid #ff9800; padding: 10px; border-radius: 8px; margin-bottom: 15px;';
                    repeatDiv.innerHTML = \`
                        <strong>🔄 Multiple Reports:</strong><br>
                        \${repeatOffenders.map(([name, reps]) => \`\${name} (\${reps.length} reports)\`).join(', ')}
                    \`;
                    container.appendChild(repeatDiv);
                }
            }
            
            // Process reports and fetch profile data
            for (const report of reports) {
                const card = document.createElement('div');
                
                // Get reason class for color coding
                const reasonClass = getReasonClass(report.reason);
                card.className = \`report-card \${reasonClass}\`;
                
                // Use EXACT same logic as Gallery Profiles tab
                let profileHtml = '';
                try {
                    const response = await fetch(\`\${serverUrl}/gallery?admin=true&key=\${adminKey}\`);
                    const profiles = await response.json();
                    
                    // Find the profile using the same method as Gallery Profiles
                    const profile = profiles.find(p => 
                        p.CharacterName === report.reportedCharacterName || 
                        p.CharacterId === report.reportedCharacterId
                    );
                    
                    if (profile) {
                        // EXACT same image logic as Gallery Profiles tab
                        const imageHtml = profile.ProfileImageUrl 
                            ? \`<img src="\${profile.ProfileImageUrl}" 
                                    alt="\${profile.CharacterName}" 
                                    class="reported-profile-image" 
                                    onclick="openImageModal('\${profile.ProfileImageUrl}', '\${profile.CharacterName}')"
                                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                               <div class="reported-profile-placeholder" style="display: none;">🖼️</div>\`
                            : \`<div class="reported-profile-placeholder">🖼️</div>\`;
                        
                        // FIXED: Only show action buttons for pending reports, and NO NSFW BUTTON for NSFW profiles
                        const actionButtonsHtml = !isArchived ? \`
                            <div class="reported-profile-actions">
                                <button class="btn btn-danger" onclick="confirmRemoveProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                                    Remove
                                </button>
                                <button class="btn btn-warning" onclick="confirmBanProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                                    Ban
                                </button>
                                \${profile.IsNSFW ? '' : \`<button class="btn btn-nsfw" onclick="toggleNSFW('\${profile.CharacterId}', '\${profile.CharacterName}', false)">Mark NSFW</button>\`}
                            </div>
                        \` : '';
                        
                        // Show either Gallery Status OR Bio (Gallery Status takes priority) - SAME AS GALLERY TAB
                        let statusContent = '';
                        if (profile.GalleryStatus && profile.GalleryStatus.trim()) {
                            statusContent = \`<div class="gallery-status">\${profile.GalleryStatus}</div>\`;
                        } else if (profile.Bio && profile.Bio.trim()) {
                            statusContent = \`<div style="color: #ddd; font-size: 0.9em; margin: 4px 0; max-height: 60px; overflow: hidden;">\${profile.Bio}</div>\`;
                        } else {
                            statusContent = \`<div style="color: #999; font-style: italic; margin: 4px 0;">No bio</div>\`;
                        }

                        profileHtml = \`
                            <div class="reported-profile">
                                \${imageHtml}
                                <div class="reported-profile-name">\${profile.CharacterName}</div>
                                <div class="reported-profile-server">\${profile.Server}</div>
                                \${statusContent}
                                \${actionButtonsHtml}
                            </div>
                        \`;
                    } else {
                        // Profile not found
                        profileHtml = \`
                            <div class="reported-profile">
                                <div class="reported-profile-placeholder">❌</div>
                                <div class="reported-profile-name">Profile Missing</div>
                                <div class="reported-profile-server">Removed/Private</div>
                            </div>
                        \`;
                    }
                } catch (error) {
                    // Error fetching
                    profileHtml = \`
                        <div class="reported-profile">
                            <div class="reported-profile-placeholder">⚠️</div>
                            <div class="reported-profile-name">Error Loading</div>
                            <div class="reported-profile-server">-</div>
                        </div>
                    \`;
                }
                
                const actionButtons = report.status === 'pending' ? \`
                    <div style="margin-top: 10px;">
                        <button class="btn btn-primary" onclick="updateReport('\${report.id}', 'resolved')">Mark Resolved</button>
                        <button class="btn btn-warning" onclick="updateReport('\${report.id}', 'dismissed')">Dismiss</button>
                    </div>
                \` : \`
                    <div style="margin-top: 10px;">
                        <span style="color: #4CAF50; font-size: 0.9em;">✅ \${report.status.toUpperCase()}</span>
                        \${report.reviewedAt ? \` on \${new Date(report.reviewedAt).toLocaleDateString()}\` : ''}
                        \${report.reviewedBy ? \` by \${report.reviewedBy}\` : ''}
                        \${report.adminNotes ? \`<br><strong>Admin Notes:</strong> \${report.adminNotes}\` : ''}
                    </div>
                \`;
                
                card.innerHTML = \`
                    <div class="report-info">
                        <div class="report-header">
                            <strong>\${report.reportedCharacterName}</strong>
                            <span class="btn btn-\${report.status === 'pending' ? 'warning' : (report.status === 'resolved' ? 'primary' : 'secondary')}">\${report.status}</span>
                        </div>
                        <div class="reason-badge \${reasonClass}">\${report.reason}</div>
                        <p><strong>Details:</strong> \${report.details || 'None'}</p>
                        <p><strong>Reported by:</strong> \${report.reporterCharacter}</p>
                        <p><strong>Date:</strong> \${new Date(report.createdAt).toLocaleDateString()}</p>
                        \${actionButtons}
                    </div>
                    \${profileHtml}
                \`;
                container.appendChild(card);
            }
        }
        
        async function toggleNSFW(characterId, characterName, currentNSFW) {
            // Only allow marking as NSFW, not removing NSFW flag
            if (currentNSFW) {
                alert('NSFW profiles cannot be unmarked. Use Remove button if needed.');
                return;
            }
            
            if (!confirm(\`Are you sure you want to mark \${characterName} as NSFW?\`)) {
                return;
            }
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}/nsfw\`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ isNSFW: true })
                });
                
                if (response.ok) {
                    alert(\`\${characterName} has been marked as NSFW\`);
                    loadProfiles(); // Refresh the profiles
                    // Refresh current tab if it's reports
                    const activeTab = document.querySelector('.tab.active');
                    if (activeTab && (activeTab.textContent.includes('Reports'))) {
                        if (activeTab.textContent.includes('Pending')) {
                            loadReports();
                        } else if (activeTab.textContent.includes('Archived')) {
                            loadArchivedReports();
                        }
                    }
                } else {
                    alert('Error updating NSFW status');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // Helper function to get CSS class based on report reason
        function getReasonClass(reason) {
            const reasonLower = reason.toLowerCase();
            if (reasonLower.includes('spam')) return 'reason-spam';
            if (reasonLower.includes('inappropriate') || reasonLower.includes('content')) return 'reason-inappropriate';
            if (reasonLower.includes('malicious') || reasonLower.includes('link')) return 'reason-malicious';
            if (reasonLower.includes('harassment') || reasonLower.includes('abuse')) return 'reason-harassment';
            return 'reason-other';
        }
        
        async function updateReport(reportId, status) {
            const adminNotes = prompt('Add admin notes (optional):');
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/reports/\${reportId}\`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ status, adminNotes })
                });
                
                if (response.ok) {
                    alert('✅ Report updated');
                    await loadReports();
                    await loadArchivedReports();
                    await refreshStats();
                } else {
                    alert('❌ Error updating report');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        async function createAnnouncement() {
            const title = document.getElementById('announcementTitle').value;
            const message = document.getElementById('announcementMessage').value;
            const type = document.getElementById('announcementType').value;
            
            if (!title || !message) {
                alert('Please fill in title and message');
                return;
            }
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ title, message, type })
                });
                
                if (response.ok) {
                    alert('✅ Announcement created');
                    document.getElementById('announcementTitle').value = '';
                    document.getElementById('announcementMessage').value = '';
                    loadAnnouncements();
                    await refreshStats();
                } else {
                    alert('❌ Error creating announcement');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        async function loadAnnouncements() {
            const loading = document.getElementById('announcementsLoading');
            const container = document.getElementById('announcementsContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements?adminKey=\${adminKey}\`);
                const announcements = await response.json();
                
                loading.style.display = 'none';
                
                announcements.forEach(announcement => {
                    const card = document.createElement('div');
                    card.className = 'announcement-card';
                    card.innerHTML = \`
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <strong>\${announcement.title}</strong>
                            <span class="btn btn-\${announcement.active ? 'primary' : 'warning'}">\${announcement.active ? 'Active' : 'Inactive'}</span>
                        </div>
                        <p>\${announcement.message}</p>
                        <p><strong>Type:</strong> \${announcement.type}</p>
                        <p><strong>Created:</strong> \${new Date(announcement.createdAt).toLocaleDateString()}</p>
                        \${announcement.active ? \`
                            <button class="btn btn-warning" onclick="deactivateAnnouncement('\${announcement.id}')">Deactivate</button>
                        \` : ''}
                        <button class="btn btn-danger" onclick="deleteAnnouncement('\${announcement.id}')">Delete</button>
                    \`;
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading announcements: \${error.message}</div>\`;
            }
        }
        
        async function deactivateAnnouncement(id) {
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements/\${id}/deactivate\`, {
                    method: 'PATCH',
                    headers: { 
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    }
                });
                
                if (response.ok) {
                    loadAnnouncements();
                    await refreshStats();
                } else {
                    alert('❌ Error deactivating announcement');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        async function deleteAnnouncement(id) {
            if (!confirm('Are you sure you want to delete this announcement?')) return;
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements/\${id}\`, {
                    method: 'DELETE',
                    headers: { 
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    }
                });
                
                if (response.ok) {
                    loadAnnouncements();
                    await refreshStats();
                } else {
                    alert('❌ Error deleting announcement');
                }
            } catch (error) {
                alert(\`❌ Error: \${error.message}\`);
            }
        }
        
        async function loadModerationLog() {
            const loading = document.getElementById('moderationLoading');
            const container = document.getElementById('moderationContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/moderation/actions?adminKey=\${adminKey}\`);
                const actions = await response.json();
                
                loading.style.display = 'none';
                
                actions.forEach(action => {
                    const card = document.createElement('div');
                    card.className = 'profile-card';
                    card.innerHTML = \`
                        <div><strong>\${action.action.toUpperCase()}</strong> - \${action.characterName}</div>
                        <p><strong>Reason:</strong> \${action.reason}</p>
                        <p><strong>Admin:</strong> \${action.adminId}</p>
                        <p><strong>Date:</strong> \${new Date(action.timestamp).toLocaleString()}</p>
                    \`;
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading moderation log: \${error.message}</div>\`;
            }
        }
    </script>
    
    <!-- Confirmation Modal -->
    <div id="confirmModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title" id="modalTitle">Confirm Action</div>
                <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body" id="modalBody">
                <!-- Content will be dynamically set -->
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn" id="modalConfirmBtn" onclick="confirmModalAction()">Confirm</button>
            </div>
        </div>
    </div>
    
    <!-- Bulk Action Bar -->  
    <div id="bulkActionBar" class="bulk-action-bar">
        <div class="bulk-selection-count" id="bulkSelectionCount">0 selected</div>
        <div class="bulk-actions">
            <input type="text" id="bulkActionReason" placeholder="Enter reason for action...">
            <button class="btn btn-danger" onclick="bulkRemoveProfiles()">Remove Selected</button>
            <button class="btn btn-warning" onclick="bulkBanProfiles()">Ban Selected</button>
            <button class="btn btn-nsfw" onclick="bulkMarkNSFW()">Mark Selected as NSFW</button>
            <button class="btn btn-secondary" onclick="clearAllSelections()">Clear Selection</button>
        </div>
    </div>
</body>
</html>
    `;
    
    res.send(adminHtml);
});

// =============================================================================
// ALL YOUR EXISTING ENDPOINTS (keeping them exactly the same)
// =============================================================================

// Health check
app.get("/health", (req, res) => {
    res.status(200).json({ 
        status: "healthy", 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Upload endpoints (keeping all existing logic)
app.post("/upload/:name", upload.single("image"), async (req, res) => {
    try {
        const physicalCharacterName = decodeURIComponent(req.params.name);
        const profileJson = req.body.profile;

        if (!profileJson) {
            return res.status(400).send("Missing profile data.");
        }

        let profile;
        try {
            profile = JSON.parse(profileJson);
        } catch (err) {
            return res.status(400).send("Invalid profile JSON.");
        }

        const csCharacterName = profile.CharacterName;
        if (!csCharacterName) {
            return res.status(400).send("Missing CharacterName in profile data.");
        }

        const sanitizedCSName = csCharacterName.replace(/[^\w\s\-.']/g, "_");
        const newFileName = `${sanitizedCSName}_${physicalCharacterName}`;
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        if (moderationDB.isProfileBanned(characterId)) {
            return res.status(403).json({ error: 'Profile has been banned from the gallery' });
        }

        await cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName);

        delete profile.LikeCount;
        profile.LikeCount = likesDB.getLikeCount(characterId);

        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);
            
            await safeFileMove(req.file.path, finalImagePath);

            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        galleryCache = null;

        // Auto-flag check for problematic content
        autoFlagDB.scanProfile(characterId, csCharacterName, profile.Bio, profile.GalleryStatus, profile.Tags);

        // Log activity
        activityDB.logActivity('upload', `NEW PROFILE: ${csCharacterName}`, {
            characterId,
            characterName: csCharacterName,
            server: extractServerFromName(physicalCharacterName),
            hasImage: !!req.file
        });

        console.log(`✅ Saved profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        res.json(profile);
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put("/upload/:name", upload.single("image"), async (req, res) => {
    try {
        const physicalCharacterName = decodeURIComponent(req.params.name);
        const profileJson = req.body.profile;

        if (!profileJson) {
            return res.status(400).send("Missing profile data.");
        }

        let profile;
        try {
            profile = JSON.parse(profileJson);
        } catch (err) {
            return res.status(400).send("Invalid profile JSON.");
        }

        const csCharacterName = profile.CharacterName;
        if (!csCharacterName) {
            return res.status(400).send("Missing CharacterName in profile data.");
        }

        const sanitizedCSName = csCharacterName.replace(/[^\w\s\-.']/g, "_");
        const newFileName = `${sanitizedCSName}_${physicalCharacterName}`;
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        if (moderationDB.isProfileBanned(characterId)) {
            return res.status(403).json({ error: 'Profile has been banned from the gallery' });
        }

        await cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName);

        delete profile.LikeCount;
        profile.LikeCount = likesDB.getLikeCount(characterId);

        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);
            
            await safeFileMove(req.file.path, finalImagePath);
            
            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        galleryCache = null;

        // Auto-flag check for problematic content
        autoFlagDB.scanProfile(characterId, csCharacterName, profile.Bio, profile.GalleryStatus, profile.Tags);

        // Log activity
        activityDB.logActivity('upload', `UPDATED PROFILE: ${csCharacterName}`, {
            characterId,
            characterName: csCharacterName,
            server: extractServerFromName(physicalCharacterName),
            hasImage: !!req.file
        });

        console.log(`✅ PUT updated profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        res.json(profile);
    } catch (error) {
        console.error('PUT error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// View endpoint
app.get("/view/:name", async (req, res) => {
    try {
        const requestedName = decodeURIComponent(req.params.name);
        let filePath = path.join(profilesDir, `${requestedName}.json`);
        
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                const sanitizedProfile = sanitizeProfileResponse(profile);
                return res.json(sanitizedProfile);
            } catch (err) {
                console.error(`Error reading profile ${requestedName}:`, err.message);
            }
        }

        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json')
                ));
            });
        });

        const matchingProfiles = [];
        const expectedSuffix = `_${requestedName}.json`;

        for (let i = 0; i < profileFiles.length; i += 5) {
            const batch = profileFiles.slice(i, i + 5);
            
            await Promise.all(batch.map(async (file) => {
                if (file.endsWith(expectedSuffix)) {
                    const fullPath = path.join(profilesDir, file);
                    try {
                        const stats = await new Promise((resolve, reject) => {
                            fs.stat(fullPath, (err, stats) => {
                                if (err) reject(err);
                                else resolve(stats);
                            });
                        });
                        const profileData = await readProfileAsync(fullPath);
                        
                        if (isValidProfile(profileData)) {
                            matchingProfiles.push({
                                file: file,
                                lastModified: stats.mtime,
                                profile: profileData
                            });
                        }
                    } catch (err) {
                        console.error(`Error processing ${file}:`, err.message);
                    }
                }
            }));
        }

        if (matchingProfiles.length === 0) {
            return res.status(404).json({ error: "Profile not found" });
        }

        matchingProfiles.sort((a, b) => b.lastModified - a.lastModified);
        
        const sanitizedProfile = sanitizeProfileResponse(matchingProfiles[0].profile);
        res.json(sanitizedProfile);
    } catch (err) {
        console.error(`Error in view endpoint: ${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// Gallery endpoint
app.get("/gallery", async (req, res) => {
    try {
        const isPlugin = req.headers['x-plugin-auth'] === 'cs-plus-gallery-client';
        const isAdmin = req.query.admin === 'true' && req.query.key === process.env.ADMIN_SECRET_KEY;
        const showNSFW = req.query.nsfw === 'true'; // Client can request NSFW content
        
        const now = Date.now();
        if (galleryCache && (now - galleryCacheTime) < CACHE_DURATION) {
            let profiles = galleryCache;
            
            // Apply NSFW filter if requested
            if (!showNSFW && !isAdmin) {
                profiles = profiles.filter(profile => !profile.IsNSFW);
            }
            
            if (isPlugin || isAdmin) {
                return res.json(profiles);
            } else {
                return res.json(sanitizeGalleryData(profiles));
            }
        }

        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json')
                ));
            });
        });

        const showcaseProfiles = [];
        let skippedFiles = 0;

        for (let i = 0; i < profileFiles.length; i += 10) {
            const batch = profileFiles.slice(i, i + 10);
            
            const batchResults = await Promise.all(batch.map(async (file) => {
                const characterId = file.replace('.json', '');
                const filePath = path.join(profilesDir, file);
                
                try {
                    if (moderationDB.isProfileBanned(characterId)) {
                        return null;
                    }

                    const profileData = await readProfileAsync(filePath);
                    
                    if (!isValidProfile(profileData)) {
                        skippedFiles++;
                        return null;
                    }
                    
                    if (profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2) {
                        const underscoreIndex = characterId.indexOf('_');
                        let csCharacterName, physicalCharacterName;
                        
                        if (underscoreIndex > 0) {
                            csCharacterName = characterId.substring(0, underscoreIndex);
                            physicalCharacterName = characterId.substring(underscoreIndex + 1);
                        } else {
                            csCharacterName = profileData.CharacterName || characterId.split('@')[0];
                            physicalCharacterName = characterId;
                        }

                        return {
                            CharacterId: characterId,
                            CharacterName: csCharacterName,
                            Server: extractServerFromName(physicalCharacterName),
                            ProfileImageUrl: profileData.ProfileImageUrl || null,
                            Tags: profileData.Tags || "",
                            Bio: profileData.Bio || "",
                            GalleryStatus: profileData.GalleryStatus || "",
                            Race: profileData.Race || "",
                            Pronouns: profileData.Pronouns || "",
                            Links: profileData.Links || "",
                            LikeCount: likesDB.getLikeCount(characterId),
                            LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                            ImageZoom: profileData.ImageZoom || 1.0,
                            ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 },
                            IsNSFW: profileData.IsNSFW || false // Include NSFW flag
                        };
                    }
                    return null;
                } catch (err) {
                    console.error(`[Error] Failed to process profile ${file}:`, err.message);
                    skippedFiles++;
                    return null;
                }
            }));

            batchResults.forEach(result => {
                if (result) showcaseProfiles.push(result);
            });
        }

        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);
        
        galleryCache = showcaseProfiles;
        galleryCacheTime = now;
        
        // Apply NSFW filter
        let filteredProfiles = showcaseProfiles;
        if (!showNSFW && !isAdmin) {
            filteredProfiles = showcaseProfiles.filter(profile => !profile.IsNSFW);
        }
        
        if (isPlugin || isAdmin) {
            res.json(filteredProfiles);
        } else {
            res.json(sanitizeGalleryData(filteredProfiles));
        }
        
    } catch (err) {
        console.error('Gallery error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// Like endpoints
app.post("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const likerId = req.headers['x-character-key'] || 'anonymous';
        
        const newCount = likesDB.addLike(characterId, likerId);
        
        // Log activity for new likes only
        if (newCount > (likesDB.getLikeCount(characterId) - 1)) {
            try {
                const filePath = path.join(profilesDir, `${characterId}.json`);
                if (fs.existsSync(filePath)) {
                    const profile = await readProfileAsync(filePath);
                    activityDB.logActivity('like', `LIKED: ${profile.CharacterName || characterId}`, {
                        characterId,
                        characterName: profile.CharacterName || characterId,
                        likerId,
                        newCount
                    });
                }
            } catch (err) {
                // Silent fail for activity logging
            }
        }
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                profile.LikeCount = newCount;
                profile.LastUpdated = new Date().toISOString();
                await atomicWriteProfile(filePath, profile);
            } catch (err) {
                console.error('Failed to update profile file, but like saved to database:', err);
            }
        }
        
        galleryCache = null;
        res.json({ LikeCount: newCount });
        
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: 'Failed to like profile' });
    }
});

app.delete("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const likerId = req.headers['x-character-key'] || 'anonymous';
        
        const newCount = likesDB.removeLike(characterId, likerId);
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                profile.LikeCount = newCount;
                profile.LastUpdated = new Date().toISOString();
                await atomicWriteProfile(filePath, profile);
            } catch (err) {
                console.error('Failed to update profile file, but unlike saved to database:', err);
            }
        }
        
        galleryCache = null;
        res.json({ LikeCount: newCount });
        
    } catch (err) {
        console.error('Unlike error:', err);
        res.status(500).json({ error: 'Failed to unlike profile' });
    }
});

// Friends endpoints
app.post("/friends/update-follows", async (req, res) => {
    try {
        const { character, following } = req.body;
        
        if (!character || !Array.isArray(following)) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        friendsDB.updateFriends(character, following);
        
        const followsFile = path.join(profilesDir, `${character}_follows.json`);
        const followsData = {
            character: character,
            following: following,
            lastUpdated: new Date().toISOString()
        };
        
        try {
            await atomicWriteProfile(followsFile, followsData);
        } catch (err) {
            console.error('Failed to write friends backup file:', err);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Update friends error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post("/friends/check-mutual", async (req, res) => {
    try {
        const { character } = req.body;
        
        if (!character) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        const mutualFriends = friendsDB.getMutualFriends(character);
        res.json({ mutualFriends });
        
    } catch (error) {
        console.error('Check mutual error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// MODERATION ENDPOINTS
// =============================================================================

// Get active announcements (public)
app.get("/announcements", (req, res) => {
    try {
        const announcements = announcementsDB.getActiveAnnouncements();
        res.json(announcements);
    } catch (error) {
        console.error('Get announcements error:', error);
        res.status(500).json({ error: 'Failed to get announcements' });
    }
});

// Create announcement (admin only)
app.post("/admin/announcements", requireAdmin, (req, res) => {
    try {
        const { title, message, type } = req.body;
        
        if (!title || !message) {
            return res.status(400).json({ error: 'Title and message are required' });
        }

        const announcement = announcementsDB.addAnnouncement(title, message, type);
        res.json(announcement);
    } catch (error) {
        console.error('Create announcement error:', error);
        res.status(500).json({ error: 'Failed to create announcement' });
    }
});

// Get all announcements (admin only)
app.get("/admin/announcements", requireAdmin, (req, res) => {
    try {
        const announcements = announcementsDB.getAllAnnouncements();
        res.json(announcements);
    } catch (error) {
        console.error('Get all announcements error:', error);
        res.status(500).json({ error: 'Failed to get announcements' });
    }
});

// Deactivate announcement (admin only)
app.patch("/admin/announcements/:id/deactivate", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const success = announcementsDB.deactivateAnnouncement(id);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Announcement not found' });
        }
    } catch (error) {
        console.error('Deactivate announcement error:', error);
        res.status(500).json({ error: 'Failed to deactivate announcement' });
    }
});

// Delete announcement (admin only)
app.delete("/admin/announcements/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const success = announcementsDB.deleteAnnouncement(id);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Announcement not found' });
        }
    } catch (error) {
        console.error('Delete announcement error:', error);
        res.status(500).json({ error: 'Failed to delete announcement' });
    }
});

// Submit report (public)
app.post("/reports", (req, res) => {
    try {
        const { reportedCharacterId, reportedCharacterName, reporterCharacter, reason, details } = req.body;
        
        if (!reportedCharacterId || !reporterCharacter || !reason) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const report = reportsDB.addReport(
            reportedCharacterId, 
            reportedCharacterName || reportedCharacterId, 
            reporterCharacter, 
            reason, 
            details
        );
        
        // Log activity
        activityDB.logActivity('report', `REPORTED: ${reportedCharacterName || reportedCharacterId}`, {
            reportId: report.id,
            reportedCharacterId,
            reportedCharacterName: reportedCharacterName || reportedCharacterId,
            reporterCharacter,
            reason
        });
        
        res.json({ success: true, reportId: report.id });
    } catch (error) {
        console.error('Submit report error:', error);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Get reports (admin only)
app.get("/admin/reports", requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        const reports = reportsDB.getReports(status);
        res.json(reports);
    } catch (error) {
        console.error('Get reports error:', error);
        res.status(500).json({ error: 'Failed to get reports' });
    }
});

// Update report status (admin only)
app.patch("/admin/reports/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const { status, adminNotes } = req.body;
        const adminId = req.adminId;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        const success = reportsDB.updateReportStatus(id, status, adminNotes, adminId);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Report not found' });
        }
    } catch (error) {
        console.error('Update report error:', error);
        res.status(500).json({ error: 'Failed to update report' });
    }
});

// Remove profile (admin only)
app.delete("/admin/profiles/:characterId", requireAdmin, async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason, ban } = req.body;
        const adminId = req.adminId;
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        let characterName = characterId;
        try {
            const profile = await readProfileAsync(filePath);
            characterName = profile.CharacterName || characterId;
        } catch (err) {
            // Use characterId as fallback
        }

        // Delete the profile file
        fs.unlinkSync(filePath);
        
        // Remove associated image if exists
        try {
            const imageFiles = fs.readdirSync(imagesDir);
            const associatedImage = imageFiles.find(file => file.startsWith(characterId.replace(/[^\w@\-_.]/g, "_")));
            if (associatedImage) {
                fs.unlinkSync(path.join(imagesDir, associatedImage));
                console.log(`🗑️ Deleted associated image: ${associatedImage}`);
            }
        } catch (err) {
            console.error('Error deleting associated image:', err);
        }

        moderationDB.logAction('remove', characterId, characterName, reason || 'No reason provided', adminId);
        
        if (ban) {
            moderationDB.banProfile(characterId);
            moderationDB.logAction('ban', characterId, characterName, reason || 'No reason provided', adminId);
        }

        galleryCache = null;
        
        console.log(`🛡️ Profile ${characterName} removed by ${adminId}${ban ? ' and banned' : ''}`);
        res.json({ success: true, banned: !!ban });
        
    } catch (error) {
        console.error('Remove profile error:', error);
        res.status(500).json({ error: 'Failed to remove profile' });
    }
});

// Update profile NSFW status (admin only)
app.patch("/admin/profiles/:characterId/nsfw", requireAdmin, async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { isNSFW } = req.body;
        const adminId = req.adminId;
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Read current profile
        const profile = await readProfileAsync(filePath);
        
        // Update NSFW status
        profile.IsNSFW = isNSFW;
        profile.LastUpdated = new Date().toISOString();
        
        // Save updated profile
        await atomicWriteProfile(filePath, profile);
        
        // Log moderation action
        moderationDB.logAction(
            isNSFW ? 'mark_nsfw' : 'unmark_nsfw', 
            characterId, 
            profile.CharacterName || characterId, 
            `Profile ${isNSFW ? 'marked as' : 'unmarked from'} NSFW`, 
            adminId
        );
        
        // Clear gallery cache to reflect changes
        galleryCache = null;
        
        console.log(`🛡️ Profile ${profile.CharacterName} ${isNSFW ? 'marked as' : 'unmarked from'} NSFW by ${adminId}`);
        res.json({ success: true, isNSFW });
        
    } catch (error) {
        console.error('Update NSFW status error:', error);
        res.status(500).json({ error: 'Failed to update NSFW status' });
    }
});

// Ban profile (admin only)
app.post("/admin/profiles/:characterId/ban", requireAdmin, (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason } = req.body;
        const adminId = req.adminId;
        
        moderationDB.banProfile(characterId);
        moderationDB.logAction('ban', characterId, characterId, reason || 'No reason provided', adminId);
        
        console.log(`🛡️ Profile ${characterId} banned by ${adminId}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ban profile error:', error);
        res.status(500).json({ error: 'Failed to ban profile' });
    }
});

// Unban profile (admin only)
app.post("/admin/profiles/:characterId/unban", requireAdmin, (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason } = req.body;
        const adminId = req.adminId;
        
        moderationDB.unbanProfile(characterId);
        moderationDB.logAction('unban', characterId, characterId, reason || 'No reason provided', adminId);
        
        console.log(`🛡️ Profile ${characterId} unbanned by ${adminId}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Unban profile error:', error);
        res.status(500).json({ error: 'Failed to unban profile' });
    }
});

// Get moderation actions (admin only)
app.get("/admin/moderation/actions", requireAdmin, (req, res) => {
    try {
        const actions = moderationDB.getActions();
        res.json(actions);
    } catch (error) {
        console.error('Get moderation actions error:', error);
        res.status(500).json({ error: 'Failed to get moderation actions' });
    }
});

// Get banned profiles (admin only)
app.get("/admin/moderation/banned", requireAdmin, (req, res) => {
    try {
        const bannedProfiles = Array.from(moderationDB.bannedProfiles);
        res.json(bannedProfiles);
    } catch (error) {
        console.error('Get banned profiles error:', error);
        res.status(500).json({ error: 'Failed to get banned profiles' });
    }
});

// Admin dashboard endpoint
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
    try {
        // Count all profiles
        const allProfiles = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && !f.endsWith('_follows.json'));
        
        // Count only showcase/public profiles (same logic as gallery)
        let showcaseCount = 0;
        for (const file of allProfiles) {
            try {
                const characterId = file.replace('.json', '');
                if (moderationDB.isProfileBanned(characterId)) continue;
                
                const filePath = path.join(profilesDir, file);
                const profileData = await readProfileAsync(filePath);
                
                if (isValidProfile(profileData) && 
                    (profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2)) {
                    showcaseCount++;
                }
            } catch (err) {
                // Skip invalid profiles
                continue;
            }
        }
        
        const stats = {
            totalProfiles: showcaseCount, // Now shows only public profiles
            totalReports: reportsDB.getReports().length,
            pendingReports: reportsDB.getReports('pending').length,
            totalBanned: moderationDB.bannedProfiles.size,
            totalAnnouncements: announcementsDB.getAllAnnouncements().length,
            activeAnnouncements: announcementsDB.getActiveAnnouncements().length,
            recentActions: moderationDB.getActions().slice(0, 10),
            pendingFlags: autoFlagDB.getFlaggedProfiles('pending').length
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to get dashboard data' });
    }
});

// Activity Feed endpoints
app.get("/admin/activity", requireAdmin, (req, res) => {
    try {
        const { type, limit } = req.query;
        let activities;
        
        if (type) {
            activities = activityDB.getActivitiesByType(type, parseInt(limit) || 50);
        } else {
            activities = activityDB.getActivities(parseInt(limit) || 50);
        }
        
        res.json(activities);
    } catch (error) {
        console.error('Get activity error:', error);
        res.status(500).json({ error: 'Failed to get activity' });
    }
});

// Auto-flagging endpoints
app.get("/admin/flagged", requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        const flaggedProfiles = autoFlagDB.getFlaggedProfiles(status);
        res.json(flaggedProfiles);
    } catch (error) {
        console.error('Get flagged profiles error:', error);
        res.status(500).json({ error: 'Failed to get flagged profiles' });
    }
});

app.patch("/admin/flagged/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const adminId = req.adminId;
        
        const success = autoFlagDB.updateFlagStatus(id, status, adminId);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Flag not found' });
        }
    } catch (error) {
        console.error('Update flag status error:', error);
        res.status(500).json({ error: 'Failed to update flag status' });
    }
});

app.post("/admin/flagged/keywords", requireAdmin, (req, res) => {
    try {
        const { keyword } = req.body;
        
        if (!keyword || typeof keyword !== 'string') {
            return res.status(400).json({ error: 'Valid keyword is required' });
        }
        
        const success = autoFlagDB.addKeyword(keyword);
        
        if (success) {
            res.json({ success: true, message: 'Keyword added' });
        } else {
            res.status(400).json({ error: 'Keyword already exists' });
        }
    } catch (error) {
        console.error('Add keyword error:', error);
        res.status(500).json({ error: 'Failed to add keyword' });
    }
});

app.delete("/admin/flagged/keywords/:keyword", requireAdmin, (req, res) => {
    try {
        const { keyword } = req.params;
        const success = autoFlagDB.removeKeyword(decodeURIComponent(keyword));
        
        if (success) {
            res.json({ success: true, message: 'Keyword removed' });
        } else {
            res.status(404).json({ error: 'Keyword not found' });
        }
    } catch (error) {
        console.error('Remove keyword error:', error);
        res.status(500).json({ error: 'Failed to remove keyword' });
    }
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

process.on('SIGTERM', () => {
    console.log('💤 Server shutting down gracefully...');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`✅ Character Select+ RP server running at http://localhost:${PORT}`);
    console.log(`📁 Profiles directory: ${profilesDir}`);
    console.log(`🖼️ Images directory: ${imagesDir}`);
    console.log(`🛡️ Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`💾 Database files: ${likesDbFile}, ${friendsDbFile}, ${announcementsDbFile}, ${reportsDbFile}, ${moderationDbFile}, ${activityDbFile}, ${flaggedDbFile}`);
    console.log(`🚀 Features: Gallery, Likes, Friends, Announcements, Reports, Visual Moderation Dashboard, Activity Feed, Auto-Flagging`);
    console.log(`🗂️ Using data directory: ${DATA_DIR}`);
    
    if (process.env.ADMIN_SECRET_KEY) {
        console.log(`👑 Admin access enabled - visit /admin to moderate`);
    } else {
        console.log(`⚠️  Admin access disabled - set ADMIN_SECRET_KEY environment variable to enable`);
    }
});
