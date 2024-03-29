import KDBush from 'kdbush';

const defaultOptions = {
    minZoom: 0, // min zoom to generate clusters on
    maxZoom: 16, // max zoom level to cluster the points on
    radius: 40, // cluster radius in pixels
    extent: 512, // tile extent (radius is calculated relative to it)
    nodeSize: 64, // size of the KD-tree leaf node, affects performance
    log: false, // whether to log timing info

    // a reduce function for calculating custom cluster properties
    reduce: null, // (accumulated, props) => { accumulated.sum += props.sum; }

    // initial properties of a cluster (before running the reducer)
    initial: () => ({}), // () => ({sum: 0})

    // properties to use for individual points when running the reducer
    map: props => props // props => ({sum: props.my_value})
};

export default class Supercluster {
    constructor(options) {
        this.options = extend(Object.create(defaultOptions), options);
        this.trees = new Array(this.options.maxZoom + 1);
    }

    load(points) {
        const { log, minZoom, maxZoom, nodeSize } = this.options;

        if (log) console.time('total time');

        const timerId = `prepare ${points.length} points`;
        if (log) console.time(timerId);

        this.points = points;

        // generate a cluster object for each point and index input points into a KD-tree
        let clusters = [];
        for (let i = 0; i < points.length; i++) {
            if (!points[i].geometry) continue;
            clusters.push(createPointCluster(points[i], i));
        }
        this.trees[maxZoom + 1] = new KDBush(
            clusters,
            getX,
            getY,
            nodeSize,
            Float32Array
        );

        if (log) console.timeEnd(timerId);

        // cluster points on max zoom, then cluster the results on previous zoom, etc.;
        // results in a cluster hierarchy across zoom levels
        //为每一个缩放等级创建一个`k-d`树
        for (let z = maxZoom; z >= minZoom; z--) {
            const now = +Date.now();
            console.log('cluster', JSON.stringify(clusters));
            // create a new set of clusters for the zoom and index them with a KD-tree
            // 创建点聚合
            clusters = this._cluster(clusters, z);
            this.trees[z] = new KDBush(
                clusters,
                getX,
                getY,
                nodeSize,
                Float32Array
            );

            if (log)
                console.log(
                    'z%d: %d clusters in %dms',
                    z,
                    clusters.length,
                    +Date.now() - now
                );
        }

        if (log) console.timeEnd('total time');

        return this;
    }
    /**
     * 查询聚合结果
     * @param {*} bbox
     * @param {*} zoom
     */
    getClusters(bbox, zoom) {
        // 在使用给定包围盒的`range`进行查询时，可能在较小层级时“横跨”多个世界，这里做一下限制
        let minLng = ((((bbox[0] + 180) % 360) + 360) % 360) - 180;
        const minLat = Math.max(-90, Math.min(90, bbox[1]));
        let maxLng =
            bbox[2] === 180
                ? 180
                : ((((bbox[2] + 180) % 360) + 360) % 360) - 180;
        const maxLat = Math.max(-90, Math.min(90, bbox[3]));

        if (bbox[2] - bbox[0] >= 360) {
            minLng = -180;
            maxLng = 180;
        } else if (minLng > maxLng) {
            // 这里分成两个包围盒进行查询
            const easternHem = this.getClusters(
                [minLng, minLat, 180, maxLat],
                zoom
            );
            const westernHem = this.getClusters(
                [-180, minLat, maxLng, maxLat],
                zoom
            );
            return easternHem.concat(westernHem);
        }
        // 获取对应缩放层级的`kd-tree`
        const tree = this.trees[this._limitZoom(zoom)];
        // 查询包围盒包含的要素索引数组
        const ids = tree.range(
            lngX(minLng),
            latY(maxLat),
            lngX(maxLng),
            latY(minLat)
        );
        const clusters = [];
        for (const id of ids) {
            // 通过索引找到`kd-tree`节点
            const c = tree.points[id];
            // 如果该节点是集合，创建对应的`GeoJSON Feature`
            // 如果是单个点，直接返回
            clusters.push(
                c.numPoints ? getClusterJSON(c) : this.points[c.index]
            );
        }
        return clusters;
    }
    /**
     * 根据聚合索引`id`获取对应的`children`
     * @param {*} clusterId 聚合索引id
     */
    getChildren(clusterId) {
        const originId = clusterId >> 5;
        const originZoom = clusterId % 32;
        const errorMsg = 'No cluster with the specified id.';

        const index = this.trees[originZoom];
        if (!index) throw new Error(errorMsg);

        const origin = index.points[originId];
        if (!origin) throw new Error(errorMsg);

        const r =
            this.options.radius /
            (this.options.extent * Math.pow(2, originZoom - 1));

        const ids = index.within(origin.x, origin.y, r);
        const children = [];
        for (const id of ids) {
            const c = index.points[id];
            if (c.parentId === clusterId) {
                children.push(
                    c.numPoints ? getClusterJSON(c) : this.points[c.index]
                );
            }
        }

        if (children.length === 0) throw new Error(errorMsg);

        return children;
    }

    getLeaves(clusterId, limit, offset) {
        limit = limit || 10;
        offset = offset || 0;

        const leaves = [];
        this._appendLeaves(leaves, clusterId, limit, offset, 0);

        return leaves;
    }

    getTile(z, x, y) {
        const tree = this.trees[this._limitZoom(z)];
        const z2 = Math.pow(2, z);
        const { extent, radius } = this.options;
        const p = radius / extent;
        const top = (y - p) / z2;
        const bottom = (y + 1 + p) / z2;

        const tile = {
            features: []
        };

        this._addTileFeatures(
            tree.range((x - p) / z2, top, (x + 1 + p) / z2, bottom),
            tree.points,
            x,
            y,
            z2,
            tile
        );

        if (x === 0) {
            this._addTileFeatures(
                tree.range(1 - p / z2, top, 1, bottom),
                tree.points,
                z2,
                y,
                z2,
                tile
            );
        }
        if (x === z2 - 1) {
            this._addTileFeatures(
                tree.range(0, top, p / z2, bottom),
                tree.points,
                -1,
                y,
                z2,
                tile
            );
        }

        return tile.features.length ? tile : null;
    }

    getClusterExpansionZoom(clusterId) {
        let clusterZoom = (clusterId % 32) - 1;
        while (clusterZoom <= this.options.maxZoom) {
            const children = this.getChildren(clusterId);
            clusterZoom++;
            if (children.length !== 1) break;
            clusterId = children[0].properties.cluster_id;
        }
        return clusterZoom;
    }

    _appendLeaves(result, clusterId, limit, offset, skipped) {
        const children = this.getChildren(clusterId);

        for (const child of children) {
            const props = child.properties;

            if (props && props.cluster) {
                if (skipped + props.point_count <= offset) {
                    // skip the whole cluster
                    skipped += props.point_count;
                } else {
                    // enter the cluster
                    skipped = this._appendLeaves(
                        result,
                        props.cluster_id,
                        limit,
                        offset,
                        skipped
                    );
                    // exit the cluster
                }
            } else if (skipped < offset) {
                // skip a single point
                skipped++;
            } else {
                // add a single point
                result.push(child);
            }
            if (result.length === limit) break;
        }

        return skipped;
    }

    _addTileFeatures(ids, points, x, y, z2, tile) {
        for (const i of ids) {
            const c = points[i];
            const f = {
                type: 1,
                geometry: [
                    [
                        Math.round(this.options.extent * (c.x * z2 - x)),
                        Math.round(this.options.extent * (c.y * z2 - y))
                    ]
                ],
                tags: c.numPoints
                    ? getClusterProperties(c)
                    : this.points[c.index].properties
            };
            const id = c.numPoints ? c.id : this.points[c.index].id;
            if (id !== undefined) {
                f.id = id;
            }
            tile.features.push(f);
        }
    }

    _limitZoom(z) {
        return Math.max(
            this.options.minZoom,
            Math.min(z, this.options.maxZoom + 1)
        );
    }
    /**
     * 1.使用`k-d`树的`radius`查询一定半径的所有邻居，使用的是`kdbush`的`within`方法。
     * 2.使用范围内的点坐标生成聚合点的坐标，权重为每个子集合包含的点数目
     * @param {*} points
     * @param {*} zoom
     */
    _cluster(points, zoom) {
        const clusters = [];
        const { radius, extent, reduce, initial } = this.options;
        // 范围半径
        const r = radius / (extent * Math.pow(2, zoom));

        // loop through each point
        for (let i = 0; i < points.length; i++) {
            // 以当前点为圆心
            const p = points[i];
            // 如果已经处理过，则跳过
            if (p.zoom <= zoom) continue;
            p.zoom = zoom;

            const tree = this.trees[zoom + 1];
            // 使用`kd-tree`查询半径内的所有要素索引
            const neighborIds = tree.within(p.x, p.y, r);

            let numPoints = p.numPoints || 1;
            let wx = p.x * numPoints;
            let wy = p.y * numPoints;

            let clusterProperties = null;

            if (reduce) {
                clusterProperties = initial();
                this._accumulate(clusterProperties, p);
            }
            // 使用位运算，将缩放等级编码进`id`
            const id = (i << 5) + (zoom + 1);
            // 处理查询到的`neighborIds`
            for (const neighborId of neighborIds) {
                const b = tree.points[neighborId];
                // 性能优化,过滤掉已经处理过的点
                if (b.zoom <= zoom) continue;
                // 保存`zoom`,不会重复处理
                b.zoom = zoom;
                // 创建临时变量，保存聚合点数量
                const numPoints2 = b.numPoints || 1;
                // 使用子集合点数目作为权重，计算聚合点坐标
                wx += b.x * numPoints2;
                wy += b.y * numPoints2;

                numPoints += numPoints2;
                // 更新`parentId`
                b.parentId = id;

                if (reduce) {
                    this._accumulate(clusterProperties, b);
                }
            }
            // 如果没有聚合点时，直接处理为单点
            if (numPoints === 1) {
                clusters.push(p);
            } else {
                // 创建点集合要素，加权平均后得到中心点坐标
                p.parentId = id;
                clusters.push(
                    createCluster(
                        wx / numPoints,
                        wy / numPoints,
                        id,
                        numPoints,
                        clusterProperties
                    )
                );
            }
        }

        return clusters;
    }

    _accumulate(clusterProperties, point) {
        const { map, reduce } = this.options;
        const properties = point.numPoints
            ? point.properties
            : map(this.points[point.index].properties);
        reduce(clusterProperties, properties);
    }
}
// 创建聚合生成的点聚合要素
function createCluster(x, y, id, numPoints, properties) {
    return {
        x, // 聚合后的中心点坐标
        y,
        zoom: Infinity, // the last zoom the cluster was processed at
        id, // 包含了第一个点的索引和缩放层级
        parentId: -1, // 父集合id
        numPoints, //聚合点数量
        properties
    };
}
// 创建原始的聚合点要素
function createPointCluster(p, id) {
    const [x, y] = p.geometry.coordinates;
    return {
        x: lngX(x), // projected point coordinates
        y: latY(y),
        zoom: Infinity, // the last zoom the point was processed at
        index: id, // index of the source feature in the original input array,
        parentId: -1 // parent cluster id
    };
}

function getClusterJSON(cluster) {
    return {
        type: 'Feature',
        id: cluster.id,
        properties: getClusterProperties(cluster),
        geometry: {
            type: 'Point',
            coordinates: [xLng(cluster.x), yLat(cluster.y)]
        }
    };
}

function getClusterProperties(cluster) {
    const count = cluster.numPoints;
    const abbrev =
        count >= 10000
            ? `${Math.round(count / 1000)}k`
            : count >= 1000
            ? `${Math.round(count / 100) / 10}k`
            : count;
    return extend(extend({}, cluster.properties), {
        cluster: true,
        cluster_id: cluster.id,
        point_count: count,
        point_count_abbreviated: abbrev
    });
}

// longitude/latitude to spherical mercator in [0..1] range
function lngX(lng) {
    return lng / 360 + 0.5;
}
function latY(lat) {
    const sin = Math.sin((lat * Math.PI) / 180);
    const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
    return y < 0 ? 0 : y > 1 ? 1 : y;
}

// spherical mercator to longitude/latitude
function xLng(x) {
    return (x - 0.5) * 360;
}
function yLat(y) {
    const y2 = ((180 - y * 360) * Math.PI) / 180;
    return (360 * Math.atan(Math.exp(y2))) / Math.PI - 90;
}

function extend(dest, src) {
    for (const id in src) dest[id] = src[id];
    return dest;
}

function getX(p) {
    return p.x;
}
function getY(p) {
    return p.y;
}
