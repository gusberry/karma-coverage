var path = require('path');
var fs = require('fs');
var util = require('util');
var istanbul = require('istanbul');
var dateformat = require('dateformat');


var Store = istanbul.Store;

var BasePathStore = function(opts) {
  Store.call(this, opts);
  opts = opts || {};
  this.basePath = opts.basePath;
  this.delegate = Store.create('fslookup');
};
BasePathStore.TYPE = 'basePathlookup';
util.inherits(BasePathStore, Store);

Store.mix(BasePathStore, {
  keys : function() {
    return this.delegate.keys();
  },
  toKey : function(key) {
    if (key.indexOf('./') === 0) { return path.join(this.basePath, key); }
    return key;
  },
  get : function(key) {
    return this.delegate.get(this.toKey(key));
  },
  hasKey : function(key) {
    return this.delegate.hasKey(this.toKey(key));
  },
  set : function(key, contents) {
    return this.delegate.set(this.toKey(key), contents);
  }
});


// TODO(vojta): inject only what required (config.basePath, config.coverageReporter)
var CoverageReporter = function(rootConfig, helper, logger, emitter) {
  var log = logger.create('coverage');
  var config = rootConfig.coverageReporter || {};
  var basePath = rootConfig.basePath;
  var reporters = config.reporters;

  if (!helper.isDefined(reporters)) {
    reporters = [config];
  }

  this.adapters = [];
  var collectors;
  var pendingFileWritings = 0;
  var fileWritingFinished = function() {};

  function writeEnd() {
    if (!--pendingFileWritings) {
      // cleanup collectors
      Object.keys(collectors).forEach(function(key) {
         collectors[key].dispose();
      });
      fileWritingFinished();
    }
  }


  function checkCoverage (browser, collector) {
    var defaultThresholds = {
      global: {
        statements: 0,
        branches: 0,
        lines: 0,
        functions: 0,
        excludes: []
      },
      each: {
        statements: 0,
        branches: 0,
        lines: 0,
        functions: 0,
        excludes: [],
        overrides: {}
      }
    }

    var thresholds = helper.merge({}, defaultThresholds, config.check)

    var rawCoverage = collector.getFinalCoverage()
    var globalResults = istanbul.utils.summarizeCoverage(removeFiles(rawCoverage, thresholds.global.excludes))
    var eachResults = removeFiles(rawCoverage, thresholds.each.excludes)

    // Summarize per-file results and mutate original results.
    Object.keys(eachResults).forEach(function (key) {
      eachResults[key] = istanbul.utils.summarizeFileCoverage(eachResults[key])
    })

    var coverageFailed = false

    function check (name, thresholds, actuals) {
      var keys = [
        'statements',
        'branches',
        'lines',
        'functions'
      ]

      keys.forEach(function (key) {
        var actual = actuals[key].pct
        var actualUncovered = actuals[key].total - actuals[key].covered
        var threshold = thresholds[key]

        if (threshold < 0) {
          if (threshold * -1 < actualUncovered) {
            coverageFailed = true
            log.error(browser.name + ': Uncovered count for ' + key + ' (' + actualUncovered +
              ') exceeds ' + name + ' threshold (' + -1 * threshold + ')')
          }
        } else {
          if (actual < threshold) {
            coverageFailed = true
            log.error(browser.name + ': Coverage for ' + key + ' (' + actual +
              '%) does not meet ' + name + ' threshold (' + threshold + '%)')
          }
        }
      })
    }

    check('global', thresholds.global, globalResults)

    Object.keys(eachResults).forEach(function (key) {
      var keyThreshold = helper.merge(thresholds.each, overrideThresholds(key, thresholds.each.overrides))
      check('per-file' + ' (' + key + ') ', keyThreshold, eachResults[key])
    })

    return coverageFailed
  }

  function removeFiles (covObj, patterns) {
    var obj = {}

    Object.keys(covObj).forEach(function (key) {
      // Do any patterns match the resolved key
      var found = patterns.some(function (pattern) {
        return minimatch(normalize(key), pattern, {dot: true})
      })

      // if no patterns match, keep the key
      if (!found) {
        obj[key] = covObj[key]
      }
    })

    return obj
  }

  function overrideThresholds (key, overrides) {
    var thresholds = {}

    // First match wins
    Object.keys(overrides).some(function (pattern) {
      if (minimatch(normalize(key), pattern, {dot: true})) {
        thresholds = overrides[pattern]
        return true
      }
    })

    return thresholds
  }

  /**
   * Generate the output directory from the `coverageReporter.dir` and
   * `coverageReporter.subdir` options.
   *
   * @param {String} browserName - The browser name
   * @param {String} dir - The given option
   * @param {String|Function} subdir - The given option
   *
   * @return {String} - The output directory
   */
  function generateOutputDir(browserName, dir, subdir) {
    dir = dir || 'coverage';
    subdir = subdir || browserName;

    if (typeof subdir === 'function') {
      subdir = subdir(browserName);
    }

    return path.join(dir, subdir);
  }

  this.onRunStart = function(browsers) {
    collectors = Object.create(null);

    // TODO(vojta): remove once we don't care about Karma 0.10
    if (browsers) {
      browsers.forEach(function(browser) {
        collectors[browser.id] = new istanbul.Collector();
      });
    }
  };

  this.onBrowserStart = function(browser) {
    collectors[browser.id] = new istanbul.Collector();
  };

  this.onBrowserComplete = function(browser, result) {
    var collector = collectors[browser.id];

    if (!collector) {
      return;
    }

    if (result && result.coverage) {
      collector.add(result.coverage);
    }
  };

  this.onSpecComplete = function(browser, result) {
    if (result.coverage) {
      collectors[browser.id].add(result.coverage);
    }
  };

  this.onRunComplete = function(browsers, results) {
    console.log(results)
    var checkedCoverage = {}
    reporters.forEach(function(reporterConfig) {
      browsers.forEach(function(browser) {

        var collector = collectors[browser.id];
        if (collector) {
          if (config.hasOwnProperty('check') && !checkedCoverage[browser.id]) {
            checkedCoverage[browser.id] = true
            var coverageFailed = checkCoverage(browser, collector)
            if (coverageFailed) {
              if (results) {
                results.exitCode = 1
              }
            }
          }

          pendingFileWritings++;

          var outputDir = helper.normalizeWinPath(path.resolve(basePath, generateOutputDir(browser.name,
                                                                                           reporterConfig.dir || config.dir,
                                                                                           reporterConfig.subdir || config.subdir)));

          helper.mkdirIfNotExists(outputDir, function() {
            log.debug('Writing coverage to %s', outputDir);
            var options = helper.merge({}, reporterConfig, {
              dir : outputDir,
              emitter: emitter,
              sourceStore : new BasePathStore({
                basePath : basePath
              })
            });
            var reporter = istanbul.Report.create(reporterConfig.type || 'html', options);
            try {
              reporter.writeReport(collector, true);
            } catch (e) {
              log.error(e);
            }
            writeEnd();
          });
        }

      });
    });
  };

  this.onExit = function(done) {
    if (pendingFileWritings) {
      fileWritingFinished = done;
    } else {
      done();
    }
  };
};

CoverageReporter.$inject = ['config', 'helper', 'logger', 'emitter'];

// PUBLISH
module.exports = CoverageReporter;
