const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

class GoFileDownloader {
    constructor(url, progressCallback) {
        this.url = url;
        this.rootDir = process.env.DOWNLOADDIR || '/downloads';
        this.contentDir = null;
        this.filesInfo = {};
        this.recursiveFilesIndex = 0;
        this.progressCallback = progressCallback;
    }

    log(message) {
        if (this.progressCallback) {
            this.progressCallback(message);
        }
    }

    async start() {
        try {
            if (!this.url.split('/').includes('d')) {
                this.log('Invalid URL format');
                return;
            }

            const contentId = this.url.split('/').pop();
            await this.parseLinksRecursively(contentId);
            
            if (!this.contentDir) {
                this.log('No content directory created, nothing to download.');
                return;
            }

            if (Object.keys(this.filesInfo).length === 0) {
                this.log('No files found to download.');
                return;
            }

            await this.downloadAll();
        } catch (error) {
            this.log(`Download failed: ${error.message}`);
        }
    }

    async parseLinksRecursively(contentId, currentPath = '') {
        const url = `https://api.gofile.io/contents/${contentId}?wt=4fd6sg89d7s6&cache=true`;
        
        const response = await this.fetchJson(url);
        if (!response || response.status !== 'ok') {
            throw new Error('Failed to fetch content info');
        }

        const { data } = response;

        if (!this.contentDir) {
            this.contentDir = path.join(this.rootDir, contentId);
            await this.createDirectory(this.contentDir);
        }

        if (data.type === 'folder') {
            const folderPath = path.join(currentPath, data.name);
            await this.createDirectory(path.join(this.contentDir, folderPath));

            for (const childId in data.children) {
                const child = data.children[childId];
                if (child.type === 'folder') {
                    await this.parseLinksRecursively(child.id, folderPath);
                } else {
                    this.recursiveFilesIndex++;
                    this.filesInfo[this.recursiveFilesIndex] = {
                        path: path.join(this.contentDir, folderPath),
                        filename: child.name,
                        link: child.link
                    };
                }
            }
        } else {
            this.recursiveFilesIndex++;
            this.filesInfo[this.recursiveFilesIndex] = {
                path: this.contentDir,
                filename: data.name,
                link: data.link
            };
        }
    }

    async downloadAll() {
        const downloads = Object.values(this.filesInfo).map(fileInfo => 
            this.downloadFile(fileInfo)
        );
        await Promise.all(downloads);
        this.log('All downloads completed!');
    }

    async downloadFile(fileInfo) {
        const filePath = path.join(fileInfo.path, fileInfo.filename);
        const tempPath = `${filePath}.part`;

        if (fs.existsSync(filePath)) {
            this.log(`${fileInfo.filename} already exists, skipping.`);
            return;
        }

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };

        return new Promise((resolve, reject) => {
            https.get(fileInfo.link, { headers }, response => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download ${fileInfo.filename}`));
                    return;
                }

                const totalSize = parseInt(response.headers['content-length'], 10);
                let downloadedSize = 0;
                const fileStream = fs.createWriteStream(tempPath);

                response.on('data', chunk => {
                    downloadedSize += chunk.length;
                    const progress = (downloadedSize / totalSize * 100).toFixed(1);
                    this.log(`Downloading ${fileInfo.filename}: ${progress}%`);
                });

                fileStream.on('finish', () => {
                    fs.renameSync(tempPath, filePath);
                    this.log(`Completed: ${fileInfo.filename}`);
                    resolve();
                });

                response.pipe(fileStream);
            }).on('error', reject);
        });
    }

    async createDirectory(dir) {
        try {
            await mkdir(dir, { recursive: true });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }

    async fetchJson(url) {
        return new Promise((resolve, reject) => {
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            };

            https.get(url, { headers }, response => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(error);
                    }
                });
            }).on('error', reject);
        });
    }
}

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    return `[${timestamp}] ${message}`;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/download', (req, res) => {
    const urls = req.body.urls.filter(url => url.trim().startsWith('http'));
    if (urls.length === 0) {
        return res.status(400).send('No valid URLs provided');
    }

    urls.forEach(url => {
        const downloader = new GoFileDownloader(url, (message) => {
            const logMessage = log(message);
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(logMessage);
                }
            });
        });

        downloader.start().catch(error => {
            const errorMessage = log(`Error: ${error.message}`);
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(errorMessage);
                }
            });
        });
    });

    res.send('Download started');
});

wss.on('connection', (ws) => {
    console.log('WebSocket connection established');
    ws.on('message', (message) => {
        console.log('Received message:', message);
    });
});

server.listen(PORT, () => {
    log(`Server is running on http://localhost:${PORT}`);
});