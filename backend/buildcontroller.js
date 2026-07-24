const { Queue } = require('bullmq');
const Project = require('../models/Project');
const BuildLog = require('../models/BuildLog');

const buildQueue = new Queue('build-queue', { connection: { host: process.env.REDIS_HOST || '127.0.0.1', port: 6379 } });

exports.triggerBuild = async (req, res) => {
    try {
        const project = await Project.findById(req.body.projectId);
        if (!project || project.userId.toString() !== req.user.id) {
            return res.status(404).json({ message: 'Project context invalid.' });
        }

        // Insert new BuildLog entry
        const buildLog = new BuildLog({
            projectId: project._id,
            status: 'queued'
        });
        await buildLog.save();

        // Enqueue build job
        await buildQueue.add('compile-apk', {
            projectId: project._id,
            buildId: buildLog._id
        });

        res.status(202).json({
            message: 'App packaging compiling pipeline queued successfully.',
            buildId: buildLog._id
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server compilation dispatch failed.' });
    }
};

exports.getBuildLogs = async (req, res) => {
    try {
        const build = await BuildLog.findById(req.params.id);
        if (!build) return res.status(404).json({ message: 'Logs matching this compile cycle not found.' });
        res.json({ logs: build.logs, status: build.status, apkUrl: build.apkUrl });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching build records.' });
    }
};
