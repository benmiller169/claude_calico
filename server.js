const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('.'));

// Initialize SQLite database
const db = new sqlite3.Database(':memory:');

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        artist TEXT,
        album TEXT,
        albumArt TEXT,
        playedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        duration INTEGER
    )`);

    // Create ratings table
    db.run(`CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        songId TEXT NOT NULL,
        userId TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating IN (1, -1)),
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(songId, userId)
    )`);

    // Create song_stats table for aggregated ratings
    db.run(`CREATE TABLE IF NOT EXISTS song_stats (
        songId TEXT PRIMARY KEY,
        title TEXT,
        artist TEXT,
        thumbsUp INTEGER DEFAULT 0,
        thumbsDown INTEGER DEFAULT 0,
        lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

let currentMetadata = {
    current: {
        title: 'Live Stream',
        artist: 'Radio Calico',
        album: 'Broadcasting Live',
        albumArt: '📻'
    },
    recent: []
};

// Function to fetch metadata from CloudFront
async function fetchRadioMetadata() {
    return new Promise((resolve, reject) => {
        https.get('https://d3d4yli4hf5bmh.cloudfront.net/metadatav2.json', (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const metadata = JSON.parse(data);
                    resolve(metadata);
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            reject(error);
        });
    });
}

// Function to update metadata
async function updateMetadata() {
    try {
        const metadata = await fetchRadioMetadata();

        // Update current track
        currentMetadata.current = {
            title: metadata.title || 'Unknown Track',
            artist: metadata.artist || 'Unknown Artist',
            album: metadata.album || 'Unknown Album',
            albumArt: 'https://d3d4yli4hf5bmh.cloudfront.net/cover.jpg',
            releaseDate: metadata.release_date
        };

        // Process previous tracks (prev_artist_1, prev_title_1, etc.)
        currentMetadata.recent = [];
        for (let i = 1; i <= 5; i++) {
            const artist = metadata[`prev_artist_${i}`];
            const title = metadata[`prev_title_${i}`];

            if (artist && title) {
                currentMetadata.recent.push({
                    title: title,
                    artist: artist,
                    album: '',
                    playedAt: new Date(Date.now() - (i * 300000)).toISOString() // 5 minutes apart each
                });
            }
        }

        console.log('Metadata updated:', currentMetadata.current.title, 'by', currentMetadata.current.artist);
    } catch (error) {
        console.error('Failed to fetch metadata:', error.message);
        // Keep existing metadata on error
    }
}

// Initial metadata fetch
updateMetadata();

// Update metadata every 30 seconds
setInterval(updateMetadata, 30000);

// Helper functions for rating system
function generateSongId(title, artist) {
    return crypto.createHash('md5').update(`${title}-${artist}`).digest('hex');
}

function generateUserId(req) {
    // Generate a user ID based on IP and User-Agent for basic user identification
    const identifier = req.ip + req.get('User-Agent');
    return crypto.createHash('md5').update(identifier).digest('hex');
}

function updateSongStats(songId, title, artist, callback) {
    // Get current rating counts
    db.get(`SELECT
        COUNT(CASE WHEN rating = 1 THEN 1 END) as thumbsUp,
        COUNT(CASE WHEN rating = -1 THEN 1 END) as thumbsDown
        FROM ratings WHERE songId = ?`, [songId], (err, result) => {

        if (err) return callback(err);

        // Update or insert song stats
        db.run(`INSERT OR REPLACE INTO song_stats (songId, title, artist, thumbsUp, thumbsDown, lastUpdated)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [songId, title, artist, result.thumbsUp, result.thumbsDown], callback);
    });
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'radio-player.html'));
});

// API endpoint for metadata
app.get('/api/metadata', (req, res) => {
    const songId = generateSongId(currentMetadata.current.title, currentMetadata.current.artist);
    const userId = generateUserId(req);

    // Get rating stats for current song and user's vote
    db.get(`SELECT thumbsUp, thumbsDown FROM song_stats WHERE songId = ?`, [songId], (err, stats) => {
        if (err) {
            console.error('Stats error:', err);
            return res.json(currentMetadata);
        }

        // Get user's existing vote
        db.get(`SELECT rating FROM ratings WHERE songId = ? AND userId = ?`, [songId, userId], (err, userVote) => {
            if (err) {
                console.error('User vote error:', err);
                return res.json(currentMetadata);
            }

            const response = {
                ...currentMetadata,
                current: {
                    ...currentMetadata.current,
                    songId: songId,
                    ratings: {
                        thumbsUp: stats ? stats.thumbsUp : 0,
                        thumbsDown: stats ? stats.thumbsDown : 0,
                        userVote: userVote ? userVote.rating : null
                    }
                }
            };

            res.json(response);
        });
    });
});

// API endpoint to rate a song
app.post('/api/rate', (req, res) => {
    const { songId, title, artist, rating } = req.body;

    if (!songId || !title || !artist || (rating !== 1 && rating !== -1)) {
        return res.status(400).json({ error: 'Missing required fields or invalid rating' });
    }

    const userId = generateUserId(req);

    // Try to insert or update the rating
    db.run(`INSERT OR REPLACE INTO ratings (songId, userId, rating) VALUES (?, ?, ?)`,
        [songId, userId, rating], function(err) {
            if (err) {
                console.error('Rating error:', err);
                return res.status(500).json({ error: 'Failed to save rating' });
            }

            // Update song stats
            updateSongStats(songId, title, artist, (err) => {
                if (err) {
                    console.error('Stats update error:', err);
                    return res.status(500).json({ error: 'Failed to update stats' });
                }

                // Get updated stats
                db.get(`SELECT thumbsUp, thumbsDown FROM song_stats WHERE songId = ?`, [songId], (err, stats) => {
                    if (err) {
                        console.error('Get stats error:', err);
                        return res.status(500).json({ error: 'Failed to get updated stats' });
                    }

                    res.json({
                        success: true,
                        ratings: {
                            thumbsUp: stats.thumbsUp,
                            thumbsDown: stats.thumbsDown,
                            userVote: rating
                        }
                    });
                });
            });
        });
});

// API endpoint to get song ratings
app.get('/api/ratings/:songId', (req, res) => {
    const { songId } = req.params;
    const userId = generateUserId(req);

    db.get(`SELECT thumbsUp, thumbsDown FROM song_stats WHERE songId = ?`, [songId], (err, stats) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        db.get(`SELECT rating FROM ratings WHERE songId = ? AND userId = ?`, [songId, userId], (err, userVote) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            res.json({
                thumbsUp: stats ? stats.thumbsUp : 0,
                thumbsDown: stats ? stats.thumbsDown : 0,
                userVote: userVote ? userVote.rating : null
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Radio Calico server running at http://localhost:${PORT}`);
});