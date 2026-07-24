const mongoose = require('mongoose');

const BuildLogSchema = new mongoose.Schema({
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    status: { type: String, enum: ['queued', 'building', 'success', 'failed'], default: 'queued' },
    apkUrl: { type: String, default: '' },
    size: { type: Number, default: 0 }, // Bytes
    logs: { type: String, default: '' },
    startTime: { type: Date },
    endTime: { type: Date },
    duration: { type: Number, default: 0 } // Seconds
}, { timestamps: true });

module.exports = mongoose.model('BuildLog', BuildLogSchema);
