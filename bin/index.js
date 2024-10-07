const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require("os")

const app = express();
const port = 3000;

const tileServerUrl = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png';

const getZoomLevel = (zoomTitle) => {
    const zoomLevels = {
        station: 12,
        region: 10,
        country: 8
    };
    return zoomLevels[zoomTitle] || 0;
};

const latLonToTile = (lat, lon, zoom) => {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    const x = Math.floor((lon + 180) / 360 * n);
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x, y };
};

const tileToLatLon = (x, y, zoom) => {
    const n = Math.pow(2, zoom);
    const lon = x / n * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
    const lat = latRad * (180 / Math.PI);
    return { lat, lon };
};

const getCacheDirectory = (zoomTitle) => {
    const cacheDir = path.join(os.homedir(), '/OSMTiles', zoomTitle);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
};

const getCacheFilePath = (zoomTitle, x, y) => {
    const cacheDir = getCacheDirectory(zoomTitle);
    return path.join(cacheDir, `${zoomTitle}_${x}_${y}.png`);
};

app.get('/prerender/:zoomTitle/:lat1/:lon1/:lat2/:lon2', async (req, res) => {
    const zoomTitle = req.params.zoomTitle;
    const zoomLevel = getZoomLevel(zoomTitle);

    if (zoomLevel === 0) {
        return res.status(404).send('Invalid zoom type...');
    }

    const lat1 = parseFloat(req.params.lat1);
    const lon1 = parseFloat(req.params.lon1);
    const lat2 = parseFloat(req.params.lat2);
    const lon2 = parseFloat(req.params.lon2);

    const { x: xStart, y: yStart } = latLonToTile(lat1, lon1, zoomLevel);
    const { x: xEnd, y: yEnd } = latLonToTile(lat2, lon2, zoomLevel);

    const totalTiles = (xEnd - xStart + 1) * (yEnd - yStart + 1);
    let processedTiles = 0;
    const startTime = Date.now();

    res.set('Content-Type', 'application/json');

    for (let x = xStart; x <= xEnd; x++) {
        for (let y = yStart; y <= yEnd; y++) {
            const tileStartTime = Date.now();

            const cacheFilePath = getCacheFilePath(zoomTitle, x, y);

            try {
                const url = tileServerUrl.replace('{z}', zoomLevel).replace('{x}', x).replace('{y}', y);
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                await fs.writeFile(cacheFilePath, response.data);
            } catch (error) {
                console.error(`Failed to fetch tile at ${x}, ${y}:`, error);
                continue;
            }


            processedTiles++;

            const tileEndTime = Date.now();
            const timePerTile = ((tileEndTime - tileStartTime) / 1000).toFixed(2);

            const progress = ((processedTiles / totalTiles) * 100).toFixed(2);
            res.write(JSON.stringify({
                status: 'progress',
                progress: `${progress}%`,
                currentTile: { x, y },
                remainingTiles: totalTiles - processedTiles,
                timePerTile: `${timePerTile} seconds`
            }) + '\n');
        }
    }

    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    const avgTimePerTile = (totalTime / processedTiles).toFixed(2);

    res.write(JSON.stringify({
        status: 'complete',
        totalTiles,
        processedTiles,
        totalTime: `${totalTime} seconds`,
        avgTimePerTile: `${avgTimePerTile} seconds`
    }));
    res.end();
});

app.listen(port, () => {
    console.log(`Atlas Map Processor is running on http://localhost:${port}`);
});
