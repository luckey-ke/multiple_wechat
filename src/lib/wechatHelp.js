
const fs = require("fs");
const pr = require("child_process");
const iconv = require("iconv-lite");
const path = require("node:path");
const {findLatestFile, findLatestFileAll, findDirName} = require("./file");
const {releaseMutex, downloadHandle, killWeixinProcess, isWeixinRunning} = require("./kill");
const {GoConfigError} = require("./error");


class WechatHelp {
    constructor() {
        this.wechatDocumentPath = null;
    }

    /**
     * 获取微信文档路径
     * @returns {Promise<void>}
     */
    async #getWechatDocumentPath() {
        let wechatDocumentPath = this.wechatDocumentPath;
        if (fs.existsSync(wechatDocumentPath)){
            return wechatDocumentPath
        }
        // 1. 尝试从数据库中获取记录的微信文档目录路径
        wechatDocumentPath = window.dbDevice.getItem("wechatFilePath");

        // 2. 尝试从获取默认微信文档目录路径
        if (!fs.existsSync(wechatDocumentPath)){
            let documents = window.utools.getPath('documents');
            wechatDocumentPath = path.join(documents, "xwechat_files");

            logger.info("init local wechatFilePath",wechatDocumentPath);
        }

        // 3. 尝试从注册表中获取微信文档目录路径
        if (!fs.existsSync(wechatDocumentPath)){
            wechatDocumentPath = await this.#getRegWechatFilePath();

            logger.info("init reg wechatFilePath",wechatDocumentPath);
        }

        if (!fs.existsSync(wechatDocumentPath)){
            throw new GoConfigError("文档路径不存在")
        }

        this.wechatDocumentPath = wechatDocumentPath;

        return wechatDocumentPath;
    }

    saveWechatFilePath(tmpWechatDocumentPath){
        // 校验微信文档目录是否有问题
        let dataPath = path.join(tmpWechatDocumentPath, "all_users", "config", "global_config");
        if (!fs.existsSync(dataPath)){
            throw new Error("微信文档路径不正确")
        }

        this.wechatDocumentPath = tmpWechatDocumentPath;

        window.dbDevice.setItem("wechatFilePath", tmpWechatDocumentPath);
    }

    /**
     * 从注册表中获取微信文档路径
     * @returns {Promise<unknown>}
     */
    #getRegWechatFilePath(){
        // 从注册表中获取微信文档路径
        const CODE_PAGE = {
            '936': 'gbk',
            '65001': 'utf-8'
        };

        return new Promise((resolve, reject) => {
            pr.exec('chcp', function (chcpErr, _stdout, _stderr){
                if (chcpErr) {
                    return reject(chcpErr)
                }
                const page = _stdout.replace(/[^0-9]/ig, "");
                let _encoding = CODE_PAGE[page]

                pr.exec("REG QUERY HKEY_CURRENT_USER\\Software\\Tencent\\WeChat /v FileSavePath",{ encoding: 'buffer'},function(error,stdout,stderr){
                    if (error) {
                        return reject(error)
                    }
                    let data;
                    if (_encoding === 'utf8'){
                        data = stdout.toString()
                    }else{
                        data = iconv.decode(stdout, "gbk").toString()
                    }
                    logger.info("getRegWechatFilePath",data);
                    let matches = data.match(/[a-zA-Z]*?:.*/)
                    if (matches) return resolve(matches[0]);

                    resolve(null)
                });
            })
        })

    }

    #getRegWechatExeFilePath(){
        // 从注册表中获取微信EXE路径
        const CODE_PAGE = {
            '936': 'gbk',
            '65001': 'utf-8'
        };

        return new Promise((resolve, reject) => {
            pr.exec('chcp', function (chcpErr, _stdout, _stderr){
                if (chcpErr) {
                    return reject(chcpErr)
                }
                const page = _stdout.replace(/[^0-9]/ig, "");
                let _encoding = CODE_PAGE[page]

                pr.exec("REG QUERY HKEY_CURRENT_USER\\Software\\Tencent\\Weixin /v InstallPath",{ encoding: 'buffer'},function(error,stdout,stderr){
                    if (error) {
                        return reject(error)
                    }
                    let data;
                    if (_encoding === 'utf8'){
                        data = stdout.toString()
                    }else{
                        data = iconv.decode(stdout, "gbk").toString()
                    }
                    logger.info("getRegWechatExeFilePath",data);
                    let matches = data.match(/[a-zA-Z]*?:.*/)
                    if (matches) return resolve(matches[0]);

                    resolve(null)
                });
            })
        })
    }


    async getLocalWechatAccountList() {
        let wechatFilePath = await this.#getWechatDocumentPath();
        let configDirPath = path.join(wechatFilePath, "all_users", "plugin_save_config");
        let wxList = [];

        if (!fs.existsSync(configDirPath)){
            return wxList;
        }
        let paths = fs.readdirSync(configDirPath);

        logger.info("扫到本地记录的文件列表", paths)

        for (const dir of paths) {
            const wxidPath = path.join(configDirPath, dir);
            const wxidStats = fs.statSync(wxidPath);
            if (!wxidStats.isDirectory()) continue;
            const wxid = path.basename(wxidPath);

            const wxidRealPath = findDirName(wechatFilePath, wxid)

            logger.info("保存wxidRealPath", wxidRealPath, path.join(wxidPath, "logo.png"));

            wxList.push({
                id: wxid,
                logo: path.join(wxidPath, "logo.png"),
                name: wxid,
                path: wxidPath,
                accountPath: wxidRealPath,
                isLogin: this.isAccountLoggedIn(wxidRealPath)
            });
        }
        return wxList;
    }

    async execShell(cmd){
        return new Promise((resolve, reject) => {
            pr.exec(cmd, { encoding: 'utf8' }, (error, stdout, stderr) => {
                if (error) {
                    logger.error("执行命令失败", { cmd, error });
                    reject(error);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    /**
     * 替换 global_config 文件
     * 策略：先尝试直接删除+复制；若目标文件被锁定（Windows 上 rmSync 会静默失败），
     * 则用 rename 将锁定文件移走（Windows 允许 rename 被锁定的文件），再复制新文件。
     */
    #replaceGlobalConfig(configPath, crcPath, srcConfig, srcCrc) {
        // 尝试直接删除+复制
        try {
            fs.rmSync(configPath, { force: true });
            fs.rmSync(crcPath, { force: true });
            fs.copyFileSync(srcConfig, configPath);
            fs.copyFileSync(srcCrc, crcPath);
            return;
        } catch (e) {
            logger.warn("直接替换 global_config 失败，尝试 rename 策略", e?.message);
        }

        // rename fallback：Windows 允许 rename 被锁定的文件
        try {
            if (fs.existsSync(configPath)) {
                fs.renameSync(configPath, configPath + ".bak");
            }
            if (fs.existsSync(crcPath)) {
                fs.renameSync(crcPath, crcPath + ".bak");
            }
            fs.copyFileSync(srcConfig, configPath);
            fs.copyFileSync(srcCrc, crcPath);
            logger.info("rename 策略替换 global_config 成功");
        } catch (e) {
            throw new Error("无法替换 global_config 文件，请手动关闭微信后重试: " + e.message);
        }
    }

    /**
     * 递归复制目录（仅复制文件，跳过子目录）
     * @param {string} src - 源目录
     * @param {string} dst - 目标目录
     */
    #copyDirSync(src, dst) {
        if (!fs.existsSync(dst)) {
            fs.mkdirSync(dst, { recursive: true });
        }
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const dstPath = path.join(dst, entry.name);
            if (entry.isDirectory()) {
                this.#copyDirSync(srcPath, dstPath);
            } else {
                try {
                    fs.copyFileSync(srcPath, dstPath);
                } catch (e) {
                    logger.warn(`复制文件失败: ${srcPath} -> ${dstPath}`, e?.message);
                }
            }
        }
    }

    /**
     * 恢复账号的登录数据到 all_users/login/<wxid>/
     * 策略：先删除整个 all_users/login/ 目录，再从备份恢复目标账号目录，
     * 确保登录数据完全一致，无任何残留。
     * @param {string} wechatFilePath - 微信文档根路径
     * @param {string} wxid - 微信账号ID
     * @param {string} savedLoginDir - 备份的 login_data 目录（内含原 login/<wxid>/ 下的文件）
     */
    #restoreLoginData(wechatFilePath, wxid, savedLoginDir) {
        const loginRootDir = path.join(wechatFilePath, "all_users", "login");
        const loginTargetDir = path.join(loginRootDir, wxid);

        if (!fs.existsSync(savedLoginDir)) {
            logger.info(`备份的登录数据不存在: ${savedLoginDir}`);
            return;
        }

        // 1. 删除整个 login 根目录，彻底清除残留数据
        if (fs.existsSync(loginRootDir)) {
            try {
                fs.rmSync(loginRootDir, { recursive: true, force: true });
                logger.info(`已清理整个 login 目录: ${loginRootDir}`);
            } catch (e) {
                logger.warn(`清理 login 目录失败: ${loginRootDir}`, e?.message);
                // 回退：逐个删除子目录
                try {
                    fs.readdirSync(loginRootDir, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .forEach(d => {
                            try { fs.rmSync(path.join(loginRootDir, d.name), { recursive: true, force: true }); } catch {}
                        });
                } catch {}
            }
        }

        // 2. 从备份恢复到 all_users/login/<wxid>/ 目录
        this.#copyDirSync(savedLoginDir, loginTargetDir);

        // 验证恢复结果
        if (fs.existsSync(loginTargetDir)) {
            const restored = fs.readdirSync(loginTargetDir);
            logger.info(`已恢复登录数据到 ${loginTargetDir}, 文件: [${restored.join(', ')}]`);
        } else {
            logger.error(`恢复后目标目录不存在: ${loginTargetDir}`);
        }
    }

    /**
     * 启动微信
     * @returns {Promise<void>}
     * @param itemData
     */
    async startWx(itemData=null) {
        let wechatFilePath = await this.#getWechatDocumentPath();

        // 如果微信正在运行，先终止它，避免配置冲突导致需要重新扫码
        if (await isWeixinRunning()) {
            logger.info('检测到微信正在运行，先终止进程');
            await killWeixinProcess();
        }

        // 重新登录一个新的微信账号
        if (itemData){
            if (!fs.existsSync(itemData.path)){
                throw new Error("微信账号信息不存在");
            }

            const configPath = path.join(wechatFilePath, "all_users", "config", "global_config");
            const crcPath = path.join(wechatFilePath, "all_users", "config", "global_config.crc");
            const srcConfig = path.join(itemData.path, "global_config");
            const srcCrc = path.join(itemData.path, "global_config.crc");

            if (!fs.existsSync(srcConfig) || !fs.existsSync(srcCrc)) {
                throw new Error("备份的配置文件不存在，请重新保存微信账号");
            }

            try {
                this.#replaceGlobalConfig(configPath, crcPath, srcConfig, srcCrc);
            } catch (e) {
                logger.error("复制 global_config 失败", e?.message);
                throw new Error("无法替换 global_config 文件，请手动关闭微信后重试: " + e.message);
            }

            // 恢复账号专属的登录数据（key_info.db 等文件）
            // 策略：不删除已有 login 目录，只确保目标账号目录存在且有数据。
            // 微信免登依赖 all_users/login/ 下的已有会话数据，删除会导致需要重新扫码。
            const savedLoginDir = path.join(itemData.path, "login_data");
            const loginRootDir = path.join(wechatFilePath, "all_users", "login");

            // 检查 login 目录是否已有会话数据
            let hasExistingSession = false;
            if (fs.existsSync(loginRootDir)) {
                hasExistingSession = fs.readdirSync(loginRootDir, { withFileTypes: true })
                    .some(d => d.isDirectory());
            }

            if (fs.existsSync(savedLoginDir)) {
                const loginTargetDir = path.join(loginRootDir, itemData.id);
                if (!fs.existsSync(loginTargetDir)) {
                    // 目标目录不存在时，从备份恢复
                    this.#copyDirSync(savedLoginDir, loginTargetDir);
                    hasExistingSession = true;
                    logger.info(`目标登录目录不存在，已从备份恢复: ${loginTargetDir}`);
                } else {
                    // 目标目录已存在，保留它（微信需要这些会话数据来免登）
                    hasExistingSession = true;
                    logger.info(`目标登录目录已存在，保留现有数据: ${loginTargetDir}`);
                }
            } else {
                logger.info(`账号 ${itemData.id} 无 login_data 备份，跳过登录数据处理`);
            }

            // 关键修复：如果 login 目录没有任何会话数据，尝试从其他已保存账号复制
            // 微信免登需要至少一个会话上下文来引导登录
            if (!hasExistingSession) {
                logger.info(`login 目录为空，尝试从其他已保存账号获取会话数据`);
                const configDirPath = path.join(wechatFilePath, "all_users", "plugin_save_config");
                if (fs.existsSync(configDirPath)) {
                    const dirs = fs.readdirSync(configDirPath, { withFileTypes: true });
                    for (const dir of dirs) {
                        if (!dir.isDirectory() || dir.name === itemData.id) continue;
                        const otherLoginDir = path.join(configDirPath, dir.name, "login_data");
                        if (fs.existsSync(otherLoginDir)) {
                            const targetDir = path.join(loginRootDir, dir.name);
                            this.#copyDirSync(otherLoginDir, targetDir);
                            logger.info(`已从账号 ${dir.name} 复制会话数据到 ${targetDir}`);
                            hasExistingSession = true;
                            break;
                        }
                    }
                }
                if (!hasExistingSession) {
                    logger.warn(`没有任何已保存账号的 login_data，免登可能失败`);
                }
            }
        }else{
            fs.rmSync(path.join(wechatFilePath, "all_users", "config", "global_config"), { force: true });
            fs.rmSync(path.join(wechatFilePath, "all_users", "config", "global_config.crc"), { force: true });
        }

        logger.info("startWx")

        // 1. 杀掉互斥进程
        await releaseMutex().catch(e => {
            logger.error("杀进程锁失败", {
                message: e?.message,
                stack: e?.stack
            })
        })

        // 2. 获取微信进程路径
        let binPath = await this.#getRegWechatExeFilePath();
        if (!binPath){
            throw new GoConfigError("获取微信EXE路径失败，请检查微信是否已安装");
        }
        binPath = path.join(binPath, "Weixin.exe")
        logger.info("binPath", binPath)
        if (!fs.existsSync(binPath)){
            throw new GoConfigError("微信EXE不存在: " + binPath);
        }


        // 3. 启动微信
        window.utools.shellOpenPath(binPath);

        utools.showNotification("登录完成后请在搜索框输入“wxok”保存微信登录信息,下次直接登录")
    }

    deleteWechat(itemData) {
        if (!fs.existsSync(itemData.path)){
            throw new Error("微信账号信息不存在");
        }
        fs.rmSync(itemData.path, {recursive: true, force: true});
    }

    /**
     * 保存微信登录数据
     * @returns {{id}|*}
     */
    async saveWxData(){
        let wechatFilePath = await this.#getWechatDocumentPath();

        // 查找 \all_users\login 目录下的 key_info.db 文件最后更新时间
        let loginPath = path.join(wechatFilePath, "all_users", "login");
        if (!fs.existsSync(loginPath)){
            throw new Error("微信登录目录不存在，请检查是否已登录/微信文档路径有误");
        }

        const latestPath = findLatestFile(loginPath, "key_info.db-shm")
        if (!latestPath){
            throw new Error("微信登录目录下没有 key_info.db 文件");
        }

        // wxid
        let wxid = path.basename(latestPath);
        let wxData = {
            id: wxid,
        }
        if (!wxData || !wxData.id){   // 获取失败了
            throw new Error("获取微信用户数据失败");
        }

        // 备份一次下次快捷登录使用
        const wxidPath = path.join(wechatFilePath, "all_users", "plugin_save_config", wxData.id);
        if (!fs.existsSync(wxidPath)){
            fs.mkdirSync(wxidPath, {recursive: true});
        }

        fs.copyFileSync(path.join(wechatFilePath, "all_users", "config", "global_config"), path.join(wxidPath, "global_config"));
        fs.copyFileSync(path.join(wechatFilePath, "all_users", "config", "global_config.crc"), path.join(wxidPath, "global_config.crc"));
        const lastImgPath = findLatestFileAll(path.join(wechatFilePath, "all_users", "head_imgs", "0"))
        if (lastImgPath){
            fs.copyFileSync(lastImgPath, path.join(wxidPath, "logo.png"));
        }

        // 备份该账号专属的登录数据（all_users/login/<wxid>/ 下的 key_info.db 等文件）
        const loginSrcDir = path.join(wechatFilePath, "all_users", "login", wxid);
        const loginDstDir = path.join(wxidPath, "login_data");
        if (fs.existsSync(loginSrcDir)) {
            if (!fs.existsSync(loginDstDir)) {
                fs.mkdirSync(loginDstDir, { recursive: true });
            }
            const loginFiles = fs.readdirSync(loginSrcDir, { withFileTypes: true });
            logger.info(`备份登录数据: ${loginSrcDir}, 文件数: ${loginFiles.length}`);
            for (const entry of loginFiles) {
                const srcPath = path.join(loginSrcDir, entry.name);
                const dstPath = path.join(loginDstDir, entry.name);
                logger.info(`  备份: ${entry.name} (${entry.isDirectory() ? 'dir' : 'file'})`);
                if (entry.isFile()) {
                    try {
                        fs.copyFileSync(srcPath, dstPath);
                    } catch (e) {
                        logger.warn(`备份登录文件失败: ${srcPath}`, e?.message);
                    }
                } else if (entry.isDirectory()) {
                    try {
                        this.#copyDirSync(srcPath, dstPath);
                    } catch (e) {
                        logger.warn(`备份登录目录失败: ${srcPath}`, e?.message);
                    }
                }
            }
            logger.info(`已备份账号 ${wxid} 的登录数据到 ${loginDstDir}`);
        } else {
            logger.warn(`账号 ${wxid} 的登录目录不存在: ${loginSrcDir}`);
        }

        wxData = {
            id: wxid,
            logo: path.join(wxidPath, "logo.png"),
            name: wxid,
            path: wxidPath,
            isLogin: this.isAccountLoggedIn(path.join(wechatFilePath, wxid))
        }

        // 记录本次登录的微信账号信息
        window.dbDevice.setItem("wx_" + wxData.id,JSON.stringify(wxData));

        return wxData;
    }

    isAccountLoggedIn(accountPath){
        const msgFolder = path.join(accountPath, 'db_storage', 'message');
        logger.info(`检查 ${msgFolder} 中`);
        if (!fs.existsSync(msgFolder)) {
            logger.info(`检查 ${msgFolder} 不存在，跳过`);
            return false;
        }

        let shmCount = 0;
        let walCount = 0;

        const files = fs.readdirSync(msgFolder);
        for (const file of files) {
            if (file.endsWith('.db-shm')) {
                shmCount += 1;
                logger.info(`有 ${shmCount} 个 shm`);
            } else if (file.endsWith('.db-wal')) {
                walCount += 1;
            }

            if (shmCount >= 4 && walCount >= 4) {
                logger.info("CheckLogined：已经符合了");
                return true;
            }
        }

        return false;
    }

}


let wechatHelp = new WechatHelp();
// wechatHelp.wechatFilePath = 'D:\\Administrator\\Documents\\WeChat Files'
// wechatHelp.getLocalWechatAccountList().then(r => r => {
//     console.log(r);
// })
// console.log(wechatHelp.isAccountLoggedIn('D:\\Administrator\\Documents\\WeChat Files\\wxid_yjvyrw614h6p22'))
module.exports = {
    wechatHelp,
};
