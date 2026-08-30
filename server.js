/**
 * BOTmy PDF Merger v5
 * qpdf + queue + memory protection
 */

require("dotenv").config();

const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();


// ================= CONFIG =================

const PORT = process.env.PORT || 3000;

const MAX_FILE_SIZE =
  Number(process.env.MAX_FILE_SIZE_MB || 200) *
  1024 *
  1024;

const MAX_FILES =
  Number(process.env.MAX_FILES || 5);

const MAX_TOTAL_SIZE =
  Number(process.env.MAX_TOTAL_SIZE_MB || 1000) *
  1024 *
  1024;


// عدد عمليات الدمج المتزامنة
const MAX_QUEUE =
  Number(process.env.MAX_CONCURRENT_JOBS || 1);


const TMP_DIR =
  process.env.TMP_DIR ||
  path.join(__dirname, "tmp");


// ================= SECURITY =================

app.use(
  helmet()
);


app.use(
  cors({
    origin:
      process.env.FRONTEND_URL || "*"
  })
);


app.use(
  express.json()
);


app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 20
  })
);


// ================= QUEUE =================


let runningJobs = 0;

const queue = [];


function addJob(task){

  return new Promise((resolve,reject)=>{

    queue.push({
      task,
      resolve,
      reject
    });

    processQueue();

  });

}


async function processQueue(){

  if(runningJobs >= MAX_QUEUE)
    return;


  const job = queue.shift();

  if(!job)
    return;


  runningJobs++;

  try{

    const result =
      await job.task();

    job.resolve(result);

  }
  catch(err){

    job.reject(err);

  }
  finally{

    runningJobs--;

    processQueue();

  }

}



// ================= FILE STORAGE =================


const storage =
multer.diskStorage({

  destination(req,file,cb){

    const dir =
      path.join(
        TMP_DIR,
        crypto.randomUUID()
      );

    req.uploadDir = dir;

    fs.mkdirSync(
      dir,
      {
        recursive:true
      }
    );


    cb(null,dir);

  },


  filename(req,file,cb){

    cb(
      null,
      crypto.randomUUID()+".pdf"
    );

  }

});


const upload =
multer({

  storage,

  limits:{
    fileSize:MAX_FILE_SIZE,
    files:MAX_FILES
  }

});



// ================= HELPERS =================


async function cleanup(dir){

  if(!dir)
    return;


  await fsp.rm(
    dir,
    {
      recursive:true,
      force:true
    }
  )
  .catch(()=>{});

}



async function isPDF(file){


  const fd =
    await fsp.open(file,"r");


  const buffer =
    Buffer.alloc(5);


  await fd.read(
    buffer,
    0,
    5,
    0
  );


  await fd.close();


  return (
    buffer.toString()
      === "%PDF-"
  );

}




function runQpdf(files,out){

  return new Promise(
  (resolve,reject)=>{


    const args=[
      "--empty",
      "--pages",
      ...files,
      "--",
      out
    ];


    const proc =
      spawn(
        "qpdf",
        args
      );


    let error="";


    proc.stderr.on(
      "data",
      d=>{
        error+=d.toString();
      }
    );


    proc.on(
      "close",
      code=>{


        if(code!==0){

          return reject(
            new Error(
              error ||
              "qpdf failed"
            )
          );

        }


        resolve();

      }
    );


  });

}



// ================= ROUTES =================


app.get(
"/health",
(req,res)=>{

  res.json({

    status:"ok",

    queue:{
      waiting:queue.length,
      running:runningJobs
    }

  });

});





app.post(
"/merge",

upload.array(
  "files",
  MAX_FILES
),

async(req,res)=>{


 const dir=req.uploadDir;


 try{


   if(!req.files ||
      req.files.length < 2){

      return res.status(400)
      .json({
        error:
        "Upload at least 2 PDF files"
      });

   }



   let total=0;


   for(const file of req.files){


      total += file.size;


      if(
        !(await isPDF(file.path))
      ){

        throw new Error(
          "Invalid PDF file"
        );

      }

   }



   if(total > MAX_TOTAL_SIZE){

      throw new Error(
        "Total size exceeded"
      );

   }



   const output =
     path.join(
       dir,
       "merged.pdf"
     );



   await addJob(
     ()=>runQpdf(
       req.files.map(
         f=>f.path
       ),
       output
     )
   );



   res.setHeader(
     "Content-Type",
     "application/pdf"
   );


   res.setHeader(
     "Content-Disposition",
     'attachment; filename="merged.pdf"'
   );


   const stream =
     fs.createReadStream(
       output
     );


   req.on(
     "aborted",
     ()=>{
       stream.destroy();
     }
   );


   stream.pipe(res);



 }
 catch(err){


   res.status(500)
   .json({

     error:
       err.message ||
       "Merge failed"

   });


 }
 finally{


   setTimeout(
     ()=>cleanup(dir),
     60000
   );


 }


});



// ================= START =================


app.listen(
 PORT,
 ()=>{

 console.log(
 `BOTmy v5 running on ${PORT}`
 );

});
