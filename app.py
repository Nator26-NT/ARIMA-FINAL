import json
import time
import os
from functools import lru_cache
from datetime import datetime
from flask import Flask, render_template, request, jsonify
import yfinance as yf
import pandas as pd
import numpy as np
from pmdarima import auto_arima
from sklearn.preprocessing import StandardScaler
from dtaidistance import dtw
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)

# In‑memory cache for trained ARIMA models
_model_cache = {}

def get_date_ranges():
    now = datetime.now()
    cy = now.year
    train_start = f"{cy-1}-01-01"
    train_end = f"{cy-1}-12-31"
    recent_start = f"{cy}-01-01"
    recent_end = now.strftime("%Y-%m-%d")
    return train_start, train_end, recent_start, recent_end

def fetch_data(pair, start, end, interval):
    data = yf.download(pair, start=start, end=end, interval=interval, progress=False)
    if data.empty:
        data = yf.download(pair, start=start, end=end, interval='1d', progress=False)
    if 'Adj Close' in data.columns:
        data = data.drop(columns=['Adj Close'])
    data.columns = ['open', 'high', 'low', 'close', 'volume']
    return data

def add_features(df, atr_period):
    df = df.copy()
    df['return'] = df['close'].pct_change()
    df['volatility'] = df['return'].rolling(20).std()
    df['tr'] = np.maximum(df['high'] - df['low'],
                np.maximum(abs(df['high'] - df['close'].shift(1)),
                           abs(df['low'] - df['close'].shift(1))))
    df['atr'] = df['tr'].rolling(atr_period).mean()
    return df.dropna()

def find_cycle_signal(recent_df, train_df, window=48):
    recent_prices = recent_df['close'].values[-window:]
    if len(recent_prices) < window:
        return 0.0, 0.0
    x = np.arange(window)
    slope, intercept = np.polyfit(x, recent_prices, 1)
    recent_detrend = recent_prices - (slope*x + intercept)
    scaler = StandardScaler()
    recent_norm = scaler.fit_transform(recent_detrend.reshape(-1,1)).flatten()
    best_dist = np.inf
    best_idx = None
    for i in range(len(train_df)-window):
        hist_prices = train_df['close'].iloc[i:i+window].values
        hist_detrend = hist_prices - (np.polyfit(np.arange(window), hist_prices,1)[0]*np.arange(window) +
                                      np.polyfit(np.arange(window), hist_prices,1)[1])
        hist_norm = scaler.fit_transform(hist_detrend.reshape(-1,1)).flatten()
        dist = dtw.distance(recent_norm, hist_norm)
        if dist < best_dist:
            best_dist = dist
            best_idx = i
    if best_idx is None:
        return 0.0, 0.0
    future = train_df['return'].iloc[best_idx+window:best_idx+window+5].mean()
    return future, 1.0/(1.0+best_dist)

def get_or_train_model(pair, interval, series):
    # Create a hash that changes if the series data changes
    series_hash = pd.util.hash_pandas_object(series).sum()
    cache_key = f"{pair}_{interval}_{series_hash}"
    if cache_key in _model_cache:
        return _model_cache[cache_key]
    model = auto_arima(series, start_p=1, max_p=3, start_q=1, max_q=3,
                       seasonal=True, m=24, start_P=0, max_P=2, start_Q=0, max_Q=2,
                       information_criterion='aic', stepwise=True, suppress_warnings=True)
    _model_cache[cache_key] = model
    return model

def arima_signal(current_close, forecast, volatility, cycle_ret, cycle_conf):
    forecast_return = (forecast - current_close)/current_close
    model_sig = np.clip(forecast_return/(volatility+1e-6), -1, 1)
    cycle_sig = np.clip(cycle_ret/0.001, -1, 1)
    total = (0.6*model_sig + 0.4*cycle_conf*cycle_sig) / (0.6 + 0.4*cycle_conf + 1e-6)
    if total > 0.7:
        return "BUY", total
    elif total < -0.7:
        return "SELL", -total
    else:
        return "HOLD", 0.0

def compute_tp_sl(price, atr, signal_direction, risk_atr=1.0, reward_ratio=3.0):
    risk_amount = atr * risk_atr
    reward_amount = risk_amount * reward_ratio
    if signal_direction == "BUY":
        sl = price - risk_amount
        tp = price + reward_amount
    else:
        sl = price + risk_amount
        tp = price - reward_amount
    return tp, sl

def process_pair(pair, interval, atr_period, risk_mult, reward_ratio):
    train_start, train_end, recent_start, recent_end = get_date_ranges()
    try:
        train_df = fetch_data(pair, train_start, train_end, interval)
        recent_df = fetch_data(pair, recent_start, recent_end, interval)
        if train_df.empty or recent_df.empty:
            return None

        train_feat = add_features(train_df, atr_period)
        recent_feat = add_features(recent_df, atr_period)
        if len(recent_feat) < 10:
            return None

        # Pass interval to cache key
        model = get_or_train_model(pair, interval, train_feat['close'])

        latest_idx = len(recent_feat) - 1
        curr_point = recent_feat.iloc[:latest_idx]
        curr_row = recent_feat.iloc[latest_idx]
        cycle_ret, cycle_conf = find_cycle_signal(curr_point, train_feat, window=48)

        forecast_series = model.predict(n_periods=1)
        forecast = forecast_series.iloc[0] if hasattr(forecast_series, 'iloc') else forecast_series[0]

        signal, confidence = arima_signal(curr_row['close'], forecast,
                                          curr_row['volatility'], cycle_ret, cycle_conf)

        current_price = curr_row['close']
        current_atr = curr_row['atr']
        tp, sl = compute_tp_sl(current_price, current_atr, signal,
                               risk_atr=risk_mult, reward_ratio=reward_ratio)

        # Convert index to string for JSON serialization
        chart_data = {
            "dates": [str(d) for d in recent_feat.index],
            "prices": recent_feat['close'].tolist(),
            "signal_point": {
                "date": str(curr_row.name),
                "price": current_price,
                "signal": signal
            } if signal != "HOLD" else None
        }

        return {
            "pair": pair.replace("=X", ""),
            "signal": signal,
            "confidence": round(confidence, 3),
            "price": round(current_price, 5),
            "tp": round(tp, 5),
            "sl": round(sl, 5),
            "atr": round(current_atr, 5),
            "cycle_conf": round(cycle_conf, 3),
            "forecast": round(forecast, 5),
            "chart": chart_data,
            "error": None
        }
    except Exception as e:
        return {"pair": pair, "error": str(e)[:100]}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/signals', methods=['POST'])
def get_signals():
    data = request.get_json()
    pairs_raw = data.get('pairs', 'EURUSD=X, GBPUSD=X, USDJPY=X, AUDUSD=X, USDCAD=X, USDCHF=X, NZDUSD=X')
    pair_list = [p.strip().upper() for p in pairs_raw.split(',') if p.strip()]
    interval = data.get('interval', '1h')
    atr_period = int(data.get('atr_period', 14))
    risk_mult = float(data.get('risk_mult', 1.0))
    reward_ratio = 3.0

    results = []
    for pair in pair_list:
        res = process_pair(pair, interval, atr_period, risk_mult, reward_ratio)
        if res:
            results.append(res)
    return jsonify(results)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)