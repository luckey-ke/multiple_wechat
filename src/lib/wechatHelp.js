
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
            // 等待进程完全退出和文件释放
            await new Promise(r => setTimeout(r, 1000));
        }

        // 重新登录一个新的微信账号
        if (itemData){
            if (!fs.existsSync(itemData.path)){
                throw new Error("微信账号信息不存在");
            }

            const configPath = path.join(wechatFilePath, "all_users", "config", "global_config");
            const crcPath = path.join(wechatFilePath, "all_users", "config", "global_config.crc");

            // 进程已终止，直接复制即可
            try {
                fs.rmSync(configPath, { force: true });
                fs.rmSync(crcPath, { force: true });
                fs.copyFileSync(path.join(itemData.path, "global_config"), configPath);
                fs.copyFileSync(path.join(itemData.path, "global_config.crc"), crcPath);
            } catch (e) {
                logger.error("复制 global_config 失败", e?.message);
                throw new Error("无法替换 global_config 文件: " + e.message);
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
