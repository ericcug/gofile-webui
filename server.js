// Import necessary modules
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const fs = require('fs').promises;
const { createWriteStream, existsSync, statSync } = require('fs');
const WebSocket = require('ws');
const axios = require('axios');

// Initialize application and server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Server port
const PORT = process.env.PORT || 3000;

// Middleware to parse request bodies
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Log message with timestamp
const log = message => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    return logMessage;
};

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// GoFileDownloader class definition
class GoFileDownloader {
    constructor(url) {
        this.rootDir = process.env.GF_DOWNLOADDIR || '/downloads';
        this.token = process.env.GF_TOKEN;
        this.message = ' ';
        this.contentDir = null;
        this.filesInfo = {};
        this.init(url);
    }

    async init(url) {
        log(`Initializing GoFileDownloader for URL: ${url}`);
        if (!this.token) {
            this.token = await this.getToken();
        }
        await this.download(url);
    }

    async getToken() {
        const userAgent = process.env.GF_USERAGENT || 'Mozilla/5.0';
        const headers = {
            'User-Agent': userAgent,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };

        try {
            const response = await axios.post('https://api.gofile.io/accounts', {}, { headers });
            if (response.data.status !== 'ok') {
                throw new Error('Account creation failed!');
            }
            return response.data.data.token;
        } catch (error) {
            throw new Error(`Failed to create account: ${error.message}`);
        }
    }

    async createDir(dirname) {
        const filepath = path.join(this.rootDir, dirname);
        try {
            await fs.mkdir(filepath, { recursive: true });
            log(`Directory created: ${filepath}`);
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            log(`Directory already exists: ${filepath}`);
        }
    }

    async downloadContent(fileInfo) {
        const filepath = path.join(fileInfo.path, fileInfo.filename);
        if (existsSync(filepath) && statSync(filepath).size > 0) {
            log(`${filepath} already exists, skipping.`);
            return;
        }

        const tmpFile = `${filepath}.part`;
        const url = fileInfo.link;
        const userAgent = process.env.GF_USERAGENT || 'Mozilla/5.0';

        const headers = {
            'Cookie': `accountToken=${this.token}`,
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': userAgent,
            'Accept': '*/*',
            'Referer': `${url}${url.endsWith('/') ? '' : '/'}`,
            'Origin': url,
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
            'Pragma': 'no-cache',
            'Cache-Control': 'no-cache'
        };

        let partSize = 0;
        if (existsSync(tmpFile)) {
            partSize = statSync(tmpFile).size;
            headers['Range'] = `bytes=${partSize}-`;
        }

        try {
            const response = await axios({
                method: 'get',
                url,
                headers,
                responseType: 'stream',
                timeout: 27000
            });

            const totalSize = parseInt(response.headers['content-length'], 10);
            if (!totalSize) {
                log(`Couldn't find the file size from ${url}.`);
                return;
            }

            const writer = createWriteStream(tmpFile, { flags: 'a' });
            const startTime = process.hrtime();

            response.data.on('data', chunk => {
                const progress = ((partSize + writer.bytesWritten) / totalSize) * 100;
                const [seconds, nanoseconds] = process.hrtime(startTime);
                const rate = writer.bytesWritten / (seconds + nanoseconds / 1e9);

                let displayRate = rate;
                let unit = 'B/s';

                if (rate >= 1024 * 1024 * 1024) {
                    displayRate = rate / (1024 * 1024 * 1024);
                    unit = 'GB/s';
                } else if (rate >= 1024 * 1024) {
                    displayRate = rate / (1024 * 1024);
                    unit = 'MB/s';
                } else if (rate >= 1024) {
                    displayRate = rate / 1024;
                    unit = 'KB/s';
                }

                this.message = `\rDownloading ${fileInfo.filename}: ${partSize + writer.bytesWritten} of ${totalSize} ${progress.toFixed(1)}% ${displayRate.toFixed(1)}${unit}`;
                log(this.message);
            });

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.pipe(writer);
            });

            if (statSync(tmpFile).size === totalSize) {
                log(`\rDownloading ${fileInfo.filename}: ${totalSize} of ${totalSize} Done!`);
                await fs.rename(tmpFile, filepath);
            }
        } catch (error) {
            log(`Error downloading ${fileInfo.filename}: ${error.message}`);
            throw error;
        }
    }

    async parseLinksRecursively(contentId) {
        const userAgent = process.env.GF_USERAGENT || 'Mozilla/5.0';
        const url = `https://api.gofile.io/contents/${contentId}?wt=4fd6sg89d7s6&cache=true`;

        const headers = {
            'User-Agent': userAgent,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': '*/*',
            'Connection': 'keep-alive',
            'Authorization': `Bearer ${this.token}`
        };

        try {
            const response = await axios.get(url, { headers });
            const { data } = response.data;

            if (response.data.status !== 'ok') {
                log(`Failed to get a link as response from ${url}.`);
                return;
            }

            if (data.password && data.passwordStatus !== 'passwordOk') {
                if (!this.contentDir && data.name !== contentId) {
                    this.contentDir = path.join(this.rootDir, contentId);
                    await this.createDir(contentId);
                    process.chdir(this.contentDir);
                } else if (!this.contentDir && data.name === contentId) {
                    this.contentDir = path.join(this.rootDir, contentId);
                    await this.createDir(contentId);
                }

                await this.createDir(this.contentDir);
                process.chdir(this.contentDir);

                for (const childId in data.children) {
                    const child = data.children[childId];
                    if (child.type === 'folder') {
                        await this.parseLinksRecursively(child.id, password);
                        await this.parseLinksRecursively(child.id);
                        this.filesInfo[child.id] = {
                            path: process.cwd(),
                            filename: child.name,
                            link: child.link
                        };
                    }
                }

                process.chdir('..');
            } else {
                this.filesInfo[data.id] = {
                    path: this.rootDir,
                    filename: data.name,
                    link: data.link
                };
            }
        } catch (error) {
            log(`Error parsing links: ${error.message}`);
            throw error;
        }
    }

    async download(url) {
        try {
            const urlParts = url.split('/');
            if (urlParts[urlParts.length - 2] !== 'd') {
                log(`The url probably doesn't have an id in it: ${url}.`);
                return;
            }

            const contentId = urlParts[urlParts.length - 1];

            await this.parseLinksRecursively(contentId);
            if (!this.contentDir) {
                log(`No content directory created for url: ${url}, nothing done.`);
                this.resetClassProperties();
                return;
            }

            const dirContents = await fs.readdir(this.contentDir);
            if (dirContents.length === 0 && Object.keys(this.filesInfo).length === 0) {
                log(`Empty directory for url: ${url}, nothing done.`);
                await fs.rmdir(this.contentDir);
                this.resetClassProperties();
                return;
            }

            for (const file of Object.values(this.filesInfo)) {
                await this.downloadContent(file);
            }
            this.resetClassProperties();
        } catch (error) {
            log(`Error downloading content: ${error.message}`);
            throw error;
        }
    }

    resetClassProperties() {
        this.message = ' ';
        this.contentDir = null;
        this.filesInfo = {};
    }
}

// Endpoint to handle download requests
app.post('/download', async (req, res) => {
    const url = req.body.url.trim();
    if (!url.startsWith('http')) {
        return res.status(400).send('No valid URL provided');
    }

    try {
        const downloader = new GoFileDownloader(url);
        await downloader.download();
        res.send('Download started');
    } catch (error) {
        res.status(500).send(`Download failed: ${error.message}`);
    }
});

// Start the server
server.listen(PORT, () => {
    log(`Server is running on http://localhost:${PORT}`);
});