/*eslint-env node */
VCAP_SERVICES = {};
if(process.env.VCAP_SERVICES)
	VCAP_SERVICES = JSON.parse(process.env.VCAP_SERVICES);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; 

/*globals ERRORS VCAP_SERVICES:true*/

//GENERAL REQUIRES
var express    = require('express');
var basicAuth = require('basic-auth');
var cfenv = require('cfenv');
var appEnv     = cfenv.getAppEnv();

var app = express();
//set the app object to export so it can be required
module.exports = app;

var http	   = require('http');
var https      = require('https');
var request    = require('request');
var bodyParser = require('body-parser');
var async      = require('async'); 
var helmet     = require('helmet');
var csp        = require('helmet-csp');

//DB CONNECTION
var pword = VCAP_SERVICES["cloudantNoSQLDB"][0]["credentials"].password;
var id = VCAP_SERVICES["cloudantNoSQLDB"][0]["credentials"].username;
var dbname   = "iot_for_electronics_registration";
var Cloudant   = require("cloudant");
var dbPlatform;
var dbName; 
var deleteDbName;
var deleteListDB;

/***************************************************************/
/* Set up express server & passport                            */
/***************************************************************/
var server     = http.createServer(app);
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json({limit: '5mb'}));
app.use(bodyParser.urlencoded({limit: '5mb', extended: true }));

app.use(helmet());

app.use(csp({
  // Specify directives as normal.
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'none'"],
    imgSrc: ["'none'"]
  },

  // Set to true if you only want browsers to report errors, not block them.
  // You may also set this to a function(req, res) in order to decide dynamically
  // whether to use reportOnly mode, e.g., to allow for a dynamic kill switch.
  reportOnly: false,

  // Set to true if you want to blindly set all headers: Content-Security-Policy,
  // X-WebKit-CSP, and X-Content-Security-Policy.
  setAllHeaders: true,

  // Set to true if you want to disable CSP on Android where it can be buggy.
  disableAndroid: false,

  // Set to false if you want to completely disable any user-agent sniffing.
  // This may make the headers less compatible but it will be much faster.
  // This defaults to `true`.
  browserSniff: false
}));



app.post('/scanForDeletedDocs', function(req,res){
	var deleteAppliances = req.query.deleteAppliances;
	console.log('Does user want to delete the appliances?: ' + deleteAppliances);
	//this process will create a doc in reg db to store information about this process, so we can get it at a later time: 
	//1. orgID
	//2. timestamp of when process started
	//3. timestamp of when process completed
	//4. errors array for any errors while processing
	//5. list of docs to be deleted
	var resultOrg = req.body.orgID;
	console.log("Process started.");
	var processDoc = {};
	var apiKey = req.body.apiKey;
	var authToken = req.body.authToken;
	var deleteThese = [];
	var totalRows;
	var platformBookmark;
	var regBookmark;
	
	  // Do work 
	var cloudant = Cloudant({account:id, password:pword}, function(er1,cloudantBase) {
		if(er1){
			console.log('error 92: ' + er1)
			res.status(500).send('Error initializing process 99: ' + er1);
		}else{
			db = cloudant.db.use(dbname);
			dbName = resultOrg + '_platform_devices';
			deleteDbName = resultOrg + '_delete_list';
			console.log('worker resultOrg: ' + resultOrg);
			cloudantBase.db.create(dbName, function(er2) {
				if (!er2){
					dbPlatform = cloudantBase.db.use(dbName);
					console.log('DB created:  ' + dbName);
					var ddoc = {
					  _id: '_design/devices',
					  "views": {
					    "deviceIdTypeId": {
					      "reduce": "_count",
					      "map": "\tfunction (doc) {\r\n\t  //if(doc.typeId){\r\n\t\temit([doc.typeId ||doc.fields.applianceType, doc.deviceId ||doc.fields.applianceID]);\r\n\t}"
					    }
					  },
					  "language": "javascript"
				  	};
		
					dbPlatform.insert(ddoc,function (er3, result) {
					  if (er3) {
					  	console.log('error creating design doc in temp db');
					  	deleteTempDbs(deleteThese);
					    return res.status(500).send('Error initializing process 125: ' + er3);
					  }else{
					  	console.log('Created design document for platform_devices db: ' + result);
					  	cloudantBase.db.create(deleteDbName, function(er4){
							if (!er4){
								deleteListDB = cloudantBase.db.use(deleteDbName);
								console.log('DB created:  ' + deleteDbName);
								var ddoc2 = {
								  _id: '_design/search',
								  "views": {},
								  "language": "javascript",
								  "indexes": {
								    "all": {
								      "analyzer": "standard",
								      "index": "function (doc) {\n  index(\"value\", doc.value);\n}"
								    }
								  }
								};
					
								deleteListDB.insert(ddoc2,function (er5, result) {
								  if (er5) {
								  	console.log('error creating design doc in temp db: ' + er5);
								  	deleteTempDbs(deleteThese);
								    res.status(500).send('Error initializing process 135: ' + er5);
								    return;
								  }else{
										console.log('created design doc for delete list db');
									  	//insert doc into reg db to store all info for this process
									  	var timestamp = Date.now();
									  	var infoDoc = {"orgID":resultOrg, "timeStarted": timestamp, "timeFinished":"", "errors":[], "docsToDelete":[]};
									  	db.insert(infoDoc, function (er6, result) {
									  		if (er6){
									  			console.log('Error creating doc to store info about process: ' + er6);
									  			deleteTempDbs(deleteThese);
									  			return res.status(500).send('Error initializing process 145: '+ er6);
									  		}else{
									  			var resultID = result.id;
									  			console.log('result from creating process doc: ' + JSON.stringify(result));
									  			res.status(200).send('Process started.');
									  			//make sure to get the exact process doc we just created since there may be many
									  			db.search("orgID", "deleteProcess", {q:"_id:"+resultID, include_docs: true}, function(er7, result3){
									  				if(er7){
									  					console.log('Error searching on delete process: ' + er7);
									  					deleteTempDbs(deleteThese);
									  					return res.status(500).send('Error initializing process 151: ' + er7);
									  				}else{
									  					processDoc = result3.rows[0].doc;
									  					loadDocsInParallel();
									  				}
									  			});
									  		}
								  		});
									}
								});
							}else{
								console.error('Err creating delete list DB ' + er4 );
								deleteTempDbs(deleteThese);
								return res.status(500).send('Error initializing process 165: ' + er4);
							}
						});
					}
				});
			}else{
				console.error('Err creating temp DB ' + er2 );
				if (er2 != "Error: The database could not be created, the file already exists."){
					deleteTempDbs(deleteThese);
					return res.status(500).send('Error initializing process 173: ' + er2);
				}else{
					return res.status(500).send('Error initializing process 173: ' + er2);
				}
				
			}
		});
	}
});

	
	
	function loadDeleteListDB(docs){
		console.log('in loadDeleteListDB, length: ' + docs.length);
		deleteListDB.bulk({docs: docs}, function(err, result){
			if(err){
				console.log('error 201 in loadDeleteListDB: ' + err);
				processDoc.errors.push(err);
				//updateProcessDoc(processDoc);			
			}else{
				console.log('545 result: ' + result.statusCode);
				setTimeout(function() {
					console.log('about to wait before going to verifyToBeDeleted');
					verifyToBeDeleted()
					}, 50000);
			}
		});
	};
	
	function deleteTempDbs(deleteList){
		cloudant.db.get(deleteDbName, function(err, body) {
		if(!err){
			if (dbName == undefined || dbName === "" || dbName === null){
				res.status(500).send('Error initializing process and deleting temporary database.');
			}else{
				cloudant.db.destroy(deleteDbName, function(err) {
					if (err){
						console.log('error deleting deleteDb: ' + err);
						res.status(500).send('Error initializing process and deleting temporary database.');
					}else{
						console.log('deleted temp db: ' + deleteDbName);
						if (dbName == undefined || dbName === "" || dbName === null){
							res.status(500).send('Error initializing process and deleting temporary database.');
						}else{
							cloudant.db.get(dbName, function(err2, body2){
								if(!err2){
									cloudant.db.destroy(dbName, function(err){
										if (err){
											console.log('error 307: ' + err);
											processDoc.errors.push(err);
											//updateProcessDoc(processDoc);
										}else{
											console.log('deleted temp db: ' + dbName);
											if(deleteAppliances === "true"){
												console.log('ready to delete appliances')
												deleteAppliancesFromReg(deleteList);
											}else if (deleteAppliances === "false"){
												var finished = Date.now();
												processDoc.docsToDelete = deleteList;
												processDoc.timeFinished = finished;
												processDoc.lengthToDelete = deleteList.length;
												updateProcessDoc(processDoc);
											}
										}
									});
								}else{
									console.log('error deleting temp db: ' + err2);
									res.status(500).send('Error initializing process and deleting temporary database.');
								}
							})
							
						}
					}
				});
			}
		}else{
			console.log('error deleting temp db: ' + err);
			res.status(500).send('Error initializing process and deleting temporary database.');
		}

	});
		
	}
	
	
	function deleteAppliancesFromReg(docs){
		console.log('inside delete appliances from reg, length of appliances to delete: ' + docs.length);
		async.forEach(docs, function(doc, callback){
			//console.log('about to delete: ' + doc._id + ', ' + doc._rev);
			if(!doc._id || doc._id === null || doc._id === "" || doc._id == undefined){
				console.log('no _id found for doc');
				processDoc.errors.push("Error on delete appliance: no _id found for doc");
			}else{
				db.destroy(doc._id, doc._rev, function(er, result){
					if(er){
						console.log('error deleting appliances 199');
						processDoc.errors.push(er);
		    			callback();
					}else{
						callback();
					}
				});
			}
		}, function(er2){
			if(er2){
				processDoc.errors.push(er2);
			}else{
				console.log('deleted appliances from registration.');
				var finished = Date.now();
				processDoc.docsToDelete = docs;
				processDoc.timeFinished = finished;
				updateProcessDoc(processDoc);
			}
		});
	};
	
	function updateProcessDoc(doc){
		//console.log('inside updateProcessDoc, doc: ' + JSON.stringify(doc));
		db.insert(doc, function(er, result){
	    	if(er){
	    		console.log('201 er: ' + er)
	    		processDoc.errors.push(er);
	    		updateProcessDoc(processDoc);
	    	}else{
	    		console.log('updated process doc');
	    	}
	    });
	};
	
	function verifyToBeDeleted(){
		console.log('inside verifyToBeDeleted!');
		// Receive results from child process
		var verifyThese = [];
		var bookmark;
		var totalRowsVerify;
   		//console.log('tobedeleted.rows: ' + message);
   		//search through db docs, process 200 at a time. get all where value = 1
   		// do a search on that index, get total_rows, do the math.ceil again to do the below async.forEach for 200 records at a time
   		deleteListDB.search("search", "all", {q: "value:1", include_docs: true, limit: 100}, function(er, result)
   		{
   			if(er){
   				processDoc.errors.push(er);
   			}else{
   				bookmark = result.bookmark;
   				totalRowsVerify = result.total_rows;
   				console.log('total rows to verify: ' + totalRowsVerify);
	   			async.forEach(result.rows, function(doc, callback){
					//log for debugging ==> console.log('inside forEach, record = ' + record.key[1] + ' , ' + record.key[0]);
					db.search("devices", "byOrg", {q:"orgID:" + resultOrg + " AND applianceID:" + doc.doc.key[1] + " AND applianceType:" + doc.doc.key[0], include_docs:true}, function(er2, result2) 
					{
		    			if (er2){
		    				console.log("error in db find: " + er2);
		    				//add errors to process doc 
		    				processDoc.errors.push(er2);
		    				callback();
		    			}else{
		    				if(result2.rows.length !== 0){
		    					deleteThese.push(result2.rows[0].doc);
		    					callback();
		    				}else if (result2.rows.length === 0){
		    					callback();
		    				}
		    			}
		   			});
				}, function(er) {
					if (er){
						console.log('error 341, deleting dbs.. does code stop here?: ' + er);
						deleteTempDbs(deleteThese);
						processDoc.errors.push(er);
					}else{
						var count = 0
						//console.log('delete these length 248: ' + deleteThese.length);
						async.whilst( 
					    function() { return count < Math.ceil(totalRowsVerify/100); },
					    function(callbackWhilst) {
					        count++;
					        // do a search on that index, get total_rows, do the math.ceil again to do the below async.forEach for 200 records at a time
					   		deleteListDB.search("search", "all", {q: "value:1", include_docs: true, limit: 100, bookmark: bookmark}, function(er2, result2)
					   		{
					   			if(er2){
					   				console.log('error on 259 deleteListDB search');
					   				processDoc.errors.push(er2);
					   				callbackWhilst();
					   			}
					   			bookmark = result2.bookmark;
					   			async.forEach(result2.rows, function(doc, callback){
									//console.log('304 result 2 rows length: ' + result2.rows.length);
									db.search("devices", "byOrg", {q:"orgID:" + resultOrg + " AND applianceID:" + doc.doc.key[1] + " AND applianceType:" + doc.doc.key[0], include_docs:true}, function(er3, result3) 
									{
						    			if (er3){
						    				console.log("error in db find: " + er3);
						    				processDoc.errors.push(er3);
						    				callback();
						    			}else{
						    				//if we found the record, that means it only exists in reg db, not platform
						    				//so push it to deleteThese array
						    				if(result3.rows.length === 1){
						    					deleteThese.push(result3.rows[0].doc);
						    					callback();
						    				}else if (result3.rows.length === 0){
						    					callback();
						    				}else{
						    					console.log('result3.rows.length was not 1 or 0, it was: ' + result3.rows.length);
						    				}
						    			}
						   			});
					   			},function(err){
							    	if(err){
							    		console.log('error 281: ' + err);
							    		processDoc.errors.push(err);
		    							callbackWhilst();
							    	}else{
							    		callbackWhilst();
							    	}
							    });
				   			});
					    },
					    function (err, n) {
					    	if (err){
					    		console.log('error on 394: ' + err);
					    	}else{
					    		// all records should be cycled through, count = Math.ceil(total_rows/100)
						        console.log('count = ' + count);
						        //console.log('delete these length 339: ' + deleteThese.length);
						        //delete the temp db
								if (deleteDbName == undefined || deleteDbName === "" || deleteDbName === null){
									processDoc.errors.push('Temporary database does not exist.');
									updateProcessDoc(processDoc);
								}else{
									console.log('ready to delete db: ' + deleteDbName);
									console.log('delete these length 425: ' + deleteThese.length);
									deleteTempDbs(deleteThese);
								}
					    	}
					    }
					);
				}
		   		});
   			}
		});
	};

		
	function loadDocsInParallel(){
		async.parallel([
	  		function(callback) {
				request({
				    url: "https://" + resultOrg + ".internetofthings.ibmcloud.com/api/v0002/bulk/devices?_sort=deviceId&_limit=200",
				    auth: {user:apiKey, pass:authToken},
			        method : "GET",
				}, function(error, response, body){
				    if(error) {
				        console.log(error);
				        processDoc.errors.push(error);
				        callback();
				    } else {
				    	var count;
				        totalRows = (JSON.parse(body)).meta.total_rows;
				        if (!JSON.parse(body).hasOwnProperty("bookmark")){
				        	count = 0;
				        	callback(null, count);
				        }else{
				        	 platformBookmark = (JSON.parse(body)).bookmark;
					        console.log('total rows from platform: ' + totalRows);
							dbPlatform.bulk({docs: (JSON.parse(body)).results}, function(err){
								if(err){
									console.log("128 error on db bulk insert: " + err);
									processDoc.errors.push(err);
									callback();
								}else{
									count = 0;
									
									async.whilst( 
									    function() { return count < Math.ceil(totalRows/200); },
									    function(callback) {
									        count++;
									        //==> debugging log ==> console.log('going to load next 200 docs using bookmark: ' + platformBookmark);
								        	request({
											    url: "https://" + resultOrg + ".internetofthings.ibmcloud.com/api/v0002/bulk/devices?_sort=deviceId&_limit=200&_bookmark=" + platformBookmark,
											    auth: {user:apiKey, pass:authToken},
										        method : "GET",
											}, function(error, response, body2){
											    if(error) {
											        console.log(error);
											        processDoc.errors.push(error);
		    										callback();
											    } else {
											        platformBookmark = (JSON.parse(body2)).bookmark;
											        var docsToInsert = (JSON.parse(body2)).results; 
													dbPlatform.bulk({docs:docsToInsert}, function(err){
														if(err){
															console.log("152 error on db bulk insert: " + err);
															processDoc.errors.push(err);
		    												callback();
														}else{
															//==> debugging log ==> console.log("inserted next 200 documents, next bookmark: " + platformBookmark);
															if(err){
																var erSend = "end";
																callback(erSend, count);
															}else{
																callback(null, count);
															}
														}
													});
												}
											});
									    },
									    function (err, n) {
									    	if(err){
									    		console.log('385: ' + err);
									    	}
									        console.log('count = ' + count);
									        callback();
									    }
									);
								}
							});
				        }
				       
				    }
				});
			},
	   		function(callback) {
	   			db.search("devices", "byOrg", {q:"orgID:" + resultOrg + " AND appliance:true", sort: "applianceID<string>", limit: 200}, function(er, result) 
				{
	    			if (er){
	    				console.log("error in db find");
	    				processDoc.errors.push(er);
	    				callback();
	    			}else{
	    				regBookmark = result.bookmark;
	    				var rows = result.total_rows;
	    				console.log('total rows in reg db: ' + rows);
	    						dbPlatform.bulk({docs: result.rows}, function(err){
									if(err){
										processDoc.errors.push(err);
	    								callback();
									}else{
										console.log("inserted first 200 reg documents");
				    					var count = 0;
								
										async.whilst( 
										    function() { return count < Math.ceil(rows/200); },
										    function(callback) {
										        count++;
										        //==> debugging log ==> console.log('going to load next 200 registration docs using bookmark: ' + regBookmark);
									        	db.search("devices", "byOrg", {q:"orgID:" + resultOrg + " AND appliance:true", sort: "applianceID<string>", limit: 200, bookmark: regBookmark}, function(er2, result2) 
												{
													if (er){
									    				console.log("error in db find");
									    				processDoc.errors.push(er);
	    												callback();
									    			}else{ 
												        regBookmark = result2.bookmark;
														dbPlatform.bulk({docs: result2.rows}, function(err){
															if(err){
																console.log("212 error on db bulk insert from reg: " + err);
																processDoc.errors.push(err);
	    														callback();
															}else{
																//==> debugging log ==> console.log("inserted next 200 documents, next bookmark: " + regBookmark);
																if(err){
																	var erSend = "end";
																	callback(erSend, count);
																}else{
																	callback(null, count);
																}
															}
														});
													}
												});
										    },
										    function (err, n) {
										    	if (err){
										    		console.log('580: ' + err);
										    	}
										        console.log('count = ' + count);
										        callback();
										    }
										);
									}
								});
							}
						});
	   			}
		], function(err) { //This function gets called after the two tasks have called their "task callbacks"
	        if (err)  
	        {
	        	console.log('594: ' + err);
	        	  // Pass results back to parent process
	        	next(err); //If an error occurred, we let express handle it by calling the `next` function	   
	    	}
	    	else
	    	{
	    		console.log('back in loadDocsInParallel');
	    		setTimeout(function(){
	    			console.log('about to wait before loading view');
	    			doView();
	    			}, 50000);
	    		function doView(){
	    			dbPlatform.view("devices", "deviceIdTypeId", {reduce: true, group: true, limit:5000000}, function(er, result) 
		    		{
		    			if (er){
		    				console.log("error in dbPlatform find");
		    				processDoc.errors.push(er);
		    				updateProcessDoc(processDoc);
		    			}else{
		    				console.log('539 result.rows length: ' + result.rows.length);
		    				loadDeleteListDB(result.rows);
						}
					});
	    		}
			}	
		});
	}
});
/***************************************************************/
/* Start the server                                            */
/***************************************************************/
server.listen(process.env.VCAP_APP_PORT || 3000);
//console.log("Starting server on port " + application.application_uris[0]);
