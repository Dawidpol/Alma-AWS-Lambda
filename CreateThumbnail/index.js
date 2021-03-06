// Code based on:
// http://docs.aws.amazon.com/lambda/latest/dg/walkthrough-s3-events-adminuser-create-test-function-create-function.html

// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm')
            .subClass({ imageMagick: true }); // Enable ImageMagick integration.
var fs  = require('fs');
var child_process = require('child_process');
var path = require('path');

process.env['PATH'] += ':' + process.env['LAMBDA_TASK_ROOT'];

// constants
var MAX_WIDTH  = 200;
var MAX_HEIGHT = 200;
var MAX_SIZE = 30 * 1024 * 1024;
var THUMB_EXT = 'png';

// Handle region
AWS.config.update({region: process.env['AWS_DEFAULT_REGION'] || 'us-east-1'});

// Expects an event in the following format:
/*
{
	bucket: BUCKET_NAME,
	key:    KEY
}
*/

function exec(command, params, callback) {
	child_process.execFile(
		command, 
		params,
		null,
		function (err, stdout, stderr) {
			if (err) { console.error(command + ' Error: ' + err); }
			callback(err);
		}
	);	
}

function download(s3, bucket, key, downloadPath, range, callback) {
	console.log('downloading file and writing to ' + downloadPath);
	if (!fs.existsSync(path.dirname(downloadPath))) 
		fs.mkdirSync(path.dirname(downloadPath));
	var file = fs.createWriteStream(downloadPath);
	file.on('error', function(err) { callback(err); });
	file.on('close', function() { callback();});
	s3.getObject({
		Bucket: bucket,
		Key: key,
		Range: range
	}).createReadStream().pipe(file);
}
 
exports.handler = function(event, context) {
	var s3 = new AWS.S3();
	var bucket = event.bucket;
	// Object key may have spaces or unicode non-ASCII characters.
	var srcKey    =
    decodeURIComponent(event.key.replace(/\+/g, " "));  
	var random 		= require('node-uuid').v4();
	var tmpDir 		= "/tmp/";
	var scratch 	= "scratch/";
	var downloadPath;
	var returnObj = { };

	// Infer the file type.
	var typeMatch = srcKey.match(/\.([^.]*)$/);
	if (!typeMatch) {
		console.error('Unable to infer file type for key ' + srcKey);
		return;
	}

	var fileExt = typeMatch[1].toLowerCase();
	var fileType;
	
	switch (fileExt) {
		case "jpg":
		case "png":
		case "tif":
		//case "jp2":
			fileType = 'image';
			break;
		case "mp4":
		case "wav":
		case "m4v":
			fileType = "video";
			break;
		case "pdf":
			fileType = "pdf";
			break;
		case "doc":
		case "ppt":
		case "docx":
		case "pptx":
			fileType = "office";
			break;
		default:
			console.log('skipping unknown file type ' + srcKey);
			return;
	}
	
	async.waterfall([		
		function getRegion(next) {
			s3.getBucketLocation({Bucket: bucket}, next);
		},
		function checkSize(region, next) {
			s3 = new AWS.S3({region: region.LocationConstraint});
			s3.headObject({
				Bucket: bucket,
				Key: srcKey
			}, function(err, data) {
				if (err) next(err);
				else if (data.ContentLength > MAX_SIZE) {
					if (fileType == 'image') {
						// Download first part of file, return dimensions
						downloadPath = tmpDir + srcKey.replace(/\//g,'-');
						var range = 'bytes=0-102400';
						download(s3, bucket, srcKey, downloadPath, range, 
							function (err) {
								if (err) context.done(err);
								console.log('getting dimensions for ' + downloadPath);
								gm(downloadPath).size(function(err, size) {
									context.done(err,	
										{
											width: size.width, 
											height: size.height
										});
								});
							});
					}
					else 
					{
						console.log('skipping file > 500 MB', bucket, srcKey, data.ContentLength);
						return;
					}
				} else next(null);
			});
		},
		// Convert Word/Powerpoint to PDF
		function officeToPdf(next) {
	 		if (fileType != 'office') return next();
			console.log('Converting office file to PDF Lambda: ' + srcKey);
			var lambda = new AWS.Lambda();

			var params = {
			  FunctionName: 'PdfHandler', 
			  InvocationType: 'RequestResponse',
			  Payload: JSON.stringify({ 
			  	bucket: bucket, 
			  	key: srcKey,
			  	destination: scratch + "pdf/" + random + "/"
				})
			};

			lambda.invoke(params, function(err, data) {
				console.log(data);
				var resp = JSON.parse(data.Payload);
				console.log("PDF conversion complete: " + resp.key);
				srcKey = resp.key;
				fileType = 'pdf';
				next(err);
			});
		},
		// Download the file into a file stream
		function downloadFile(next) {
			downloadPath = tmpDir + srcKey.replace(/\//g,'-');
			download(s3, bucket, srcKey, downloadPath, null, next);
		},
		function preProcess(next) {
			var origFile;
			async.waterfall([
				// video --> image
				function videoToImage(next) {
					if (fileType != 'video') return next();
					console.log('starting ffmpeg on ' + downloadPath);
					origFile = downloadPath;
					downloadPath += "." + THUMB_EXT
					exec('./binaries/ffmpeg',
						[
							'-i', origFile,
							'-ss', '00:00:01',
							'-vframes', '1',
							'-n',
							downloadPath
						], next
					);
				},
				// PDF --> images
				function pdfToImage(next) {
					if (fileType != 'pdf') return next();
					console.log('starting convert on ' + downloadPath);
					origFile = downloadPath;
					downloadPath += "." + THUMB_EXT;

					// convert -density 150 -flatten ~/Downloads/powerpoint.pdf[0] -quality 100 -sharpen 0x1.0 powerpoint.pdf.png
					gm(origFile+"[0]") // The name of your pdf
							.density(150)
							.flatten()
					    .setFormat(THUMB_EXT)
					    .quality(100) // Quality from 0 to 100
					    .write(downloadPath, next);
				}
			], function (err) { 
				if (origFile != null) {
					console.log('deleting ' + origFile);
					fs.unlink(origFile, next);								
				} else {
					next(err)	
				}
			});
		},
		// Create thumbnail		
		function transform(next) {
			console.log('creating thumbnail for ' + downloadPath);
			gm(downloadPath).size(function(err, size) {
				// Infer the scaling factor to avoid stretching the image unnaturally.
				var scalingFactor = Math.min(
					MAX_WIDTH / size.width,
					MAX_HEIGHT / size.height
				);
				if (fileType == 'image') {
					returnObj.width = size.width;
					returnObj.height = size.height;
				}
				var width  = scalingFactor * size.width;
				var height = scalingFactor * size.height;
				
				// Transform the image buffer in memory.
				this.resize(width, height)
					.toBuffer(THUMB_EXT, 
					function(err, buffer) {
						if (err) next(err);
						else next(null, buffer);
					});
			});
		}
		], function (err, buffer) {
			if (err) { console.error(err); context.done(err); }
			else {
				try { fs.unlinkSync(downloadPath); } 
				catch(e) { console.log("Couldn't delete file", downloadPath, e); } // file is in temp dir anyway

				returnObj.fileType = THUMB_EXT;
				returnObj.buffer = buffer.toString('base64');
				context.done(err,	returnObj);
			}
		}
	);
};